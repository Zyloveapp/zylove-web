// Stage B: like state off the shared pair docs, founder status and message
// previews off the public user doc. See scripts/lib/stageB.mjs.
//
//   node scripts/migrate-stageB.mjs --dry-run   counts only (no values)
//   node scripts/migrate-stageB.mjs --apply
//
// After the Stage B functions are live (they write the new places and read
// the old ones as a fallback). Idempotent. Back up first. Credentials:
// Application Default Credentials.

import { createRequire } from 'node:module'
import { planStageB, applyStageB } from './lib/stageB.mjs'

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
const plan = await planStageB(db)
for (const [k, n] of Object.entries(plan.counts)) console.log(`  ${k.padEnd(52)} ${n}`)
if (!Object.keys(plan.counts).length) console.log('  nothing to migrate')
if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
const r = await applyStageB({ db, FieldValue }, plan)
console.log(`\nApplied: ${r.writes} writes.`)
