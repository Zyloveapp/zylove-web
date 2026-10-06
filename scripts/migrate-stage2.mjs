// Stage 2 (Play sealing): Play data off the public user doc, Play scores into
// gated pair subdocs, Play flags computed. See scripts/lib/stage2.mjs.
//
//   (cd functions && npm run build)                field lists + flag logic come from functions/lib
//   node scripts/migrate-stage2.mjs --dry-run      counts only (no values)
//   node scripts/migrate-stage2.mjs --apply
//
// Run after the Stage 2 functions, client and rules are live. Idempotent.
// Back up first (Firestore export). Credentials: Application Default Credentials.

import { createRequire } from 'node:module'
import { planStage2, applyStage2 } from './lib/stage2.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()

const plan = await planStage2(db)
const fieldCounts = new Map()
for (const u of plan.users) for (const f of u.scrub) fieldCounts.set(f, (fieldCounts.get(f) ?? 0) + 1)
console.log(`users: ${plan.users.length} (bots: ${plan.users.filter((u) => u.uid.startsWith('zbot-')).length})`)
for (const [k, n] of Object.entries(plan.counts)) console.log(`  ${k.padEnd(52)} ${n}`)
console.log('\nPublic-doc fields to remove                          docs')
for (const [f, n] of [...fieldCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(52)} ${n}`)
if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
const n = await applyStage2({ db, FieldValue }, plan)
console.log(`\nApplied: ${n} writes.`)
