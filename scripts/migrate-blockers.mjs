// Final-review blockers: data moves (F-065, F-064, §4.A1, F-071) and a
// read-only F-066 scan. See scripts/lib/blockers.mjs.
//
//   node scripts/migrate-blockers.mjs --dry-run    counts only (no names, ids or content)
//   node scripts/migrate-blockers.mjs --apply      writes; first saves every doc it will
//                                                  change or delete to handoff/_archive/blockers/
//
// Run after the final-blockers functions, client and rules are live, and
// after a Firestore export. Idempotent. Credentials: Application Default
// Credentials.

import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { applyBlockers, planBlockers, summary } from './lib/blockers.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()

const plan = await planBlockers({ db })
for (const [k, n] of Object.entries(summary(plan))) console.log(`${k.padEnd(72)} ${n}`)
if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
const dir = new URL('../handoff/_archive/blockers/', import.meta.url)
mkdirSync(dir, { recursive: true })
const file = new URL(`backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, dir)
writeFileSync(file, JSON.stringify(plan.backup, null, 1))
console.log(`\nBacked up ${Object.keys(plan.backup).length} docs to ${file.pathname}`)
const n = await applyBlockers({ db, FieldValue, Timestamp }, plan)
console.log(`Applied: ${n} writes.`)
process.exit(0)
