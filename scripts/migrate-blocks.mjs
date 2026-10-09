// Blocks after the review fixes (C1, H3, H5 — 2026-10-09): recent blocked
// chats kept read-only for both people until 30 days after the block, Explore
// hides moved to the mode the block was placed in, and C1 anomalies counted
// for a look by hand. See scripts/lib/blocks.mjs.
//
//   (cd functions && npm run build)
//   node scripts/migrate-blocks.mjs --dry-run
//       counts only (no names, ids or content)
//   node scripts/migrate-blocks.mjs --apply --backup <scratch>/blocks-backup.json
//       writes; first saves every doc it will change there. That is
//       production data — a scratch path outside the repo, deleted after.
//
// Run --apply after the functions and rules from this release are live (the
// rules are what let the person blocked read a kept chat; until the
// functions are, a new block wouldn't be kept for them). Idempotent: a
// second run finds nothing to do.
// Credentials: Application Default Credentials.

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { applyBlocks, planBlocks, summaryBlocks } from './lib/blocks.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply --backup <file>.')
  process.exit(1)
}
const backupAt = process.argv.includes('--backup') ? process.argv[process.argv.indexOf('--backup') + 1] : null
if (apply && !backupAt) {
  console.error('--apply needs --backup <scratch file>.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()

const plan = await planBlocks({ db })
for (const [k, n] of Object.entries(summaryBlocks(plan))) console.log(`${k.padEnd(80)} ${n}`)
if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
writeFileSync(backupAt, JSON.stringify(plan.backup, null, 1))
console.log(`\nBacked up ${Object.keys(plan.backup).length} docs to ${backupAt}`)
const n = await applyBlocks({ db, FieldValue, Timestamp }, plan)
console.log(`Applied: ${n} writes.`)
process.exit(0)
