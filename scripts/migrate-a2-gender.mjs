// §4.A2: gender off the public doc — genderIdentity, genderSelfDescribe,
// pronouns and the display choices move to the owner-only private/matching,
// the public doc gets the server-built genderLine, and sub-doc copies go.
// See scripts/lib/a2gender.mjs.
//
//   (cd functions && npm run build)
//   node scripts/migrate-a2-gender.mjs --dry-run
//       counts only (no names, ids or content): per field, the public docs
//       carrying it, how many move and how many conflict with a value
//       already in private/matching (the private value wins); genderLines
//       to write (empty / non-empty); curated and deleted accounts; sub-doc
//       copies to scrub (sparkProfile, playProfile, playProfiles); accounts
//       with a gender and no identity lock; docs it would back up
//   node scripts/migrate-a2-gender.mjs --apply --backup <scratch>/a2-backup.json
//       writes; first saves every doc it will change there. That is
//       production data — a scratch path outside the repo, deleted after.
//
// Run --apply after the §4.A2 functions, rules and web app are live (the new
// readers fall back to the public doc's old copies until then, and the old
// client wrote gender there). Idempotent: a second run finds nothing.
// Credentials: Application Default Credentials.

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { applyA2, planA2, summaryA2 } from './lib/a2gender.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')

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

const plan = await planA2({ db })
for (const [k, n] of Object.entries(summaryA2(plan))) console.log(`${k.padEnd(76)} ${n}`)
if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
writeFileSync(backupAt, JSON.stringify(plan.backup, null, 1))
console.log(`\nBacked up ${Object.keys(plan.backup).length} docs to ${backupAt}`)
const n = await applyA2({ db, FieldValue }, plan)
console.log(`Applied: ${n} writes.`)
process.exit(0)
