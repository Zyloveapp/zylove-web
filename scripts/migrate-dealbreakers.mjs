// Dealbreakers out of seekingPreferences: older web builds saved them in
// users/{uid}/seekingPreferences/prefs, which scoring never read (it reads
// private/matching), so they never took effect. Each account's list moves to
// private/matching where none is in effect (a first value: no 30-day stamp);
// a different list already there is kept and counted as a conflict; the
// field is removed from every seekingPreferences doc. See
// scripts/lib/dealbreakers.mjs.
//
//   (cd functions && npm run build)
//   node scripts/migrate-dealbreakers.mjs --dry-run
//       counts only (no names, ids or content): accounts with
//       seekingPreferences dealbreakers; copied; identical already;
//       conflicts (different list in effect / cleared under the limit);
//       empty lists skipped; deleted or missing accounts; invalid values
//       dropped; seekingPreferences docs losing the field; docs it would
//       back up
//   node scripts/migrate-dealbreakers.mjs --apply --backup <scratch>/dealbreakers-backup.json
//       writes; first saves every doc it will change there. That is
//       production data — a scratch path outside the repo, deleted after.
//
// Run --apply after the web app that saves dealbreakers to private/matching
// is live (until then, saves keep writing seekingPreferences). Each copy
// fires onMatchingPrefsWrite, which re-scores that person's pairs.
// Idempotent: a second run finds nothing.
// Credentials: Application Default Credentials.

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { applyDealbreakers, planDealbreakers, summaryDealbreakers } from './lib/dealbreakers.mjs'

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

const plan = await planDealbreakers({ db })
for (const [k, n] of Object.entries(summaryDealbreakers(plan))) console.log(`${k.padEnd(64)} ${n}`)
if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
writeFileSync(backupAt, JSON.stringify(plan.backup, null, 1))
console.log(`\nBacked up ${Object.keys(plan.backup).length} docs to ${backupAt}`)
const n = await applyDealbreakers({ db, FieldValue }, plan)
console.log(`Applied: ${n} writes.`)
process.exit(0)
