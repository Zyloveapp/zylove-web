// Body-type, trait and height preferences out of seekingPreferences: older web
// builds saved them in users/{uid}/seekingPreferences/prefs, which scoring
// never read (it reads private/matching), so they never took effect. Each
// account's values move to private/matching field by field where none is in
// effect; a different value already there is kept and counted as a conflict;
// the moved keys are removed from every seekingPreferences doc. See
// scripts/lib/seekingPrefs.mjs.
//
//   (cd functions && npm run build)
//   node scripts/migrate-seeking-prefs.mjs --dry-run
//       counts only (no names, ids or content): accounts with seekingPreferences
//       body types, traits or height; then for each of body types, traits and
//       height range: accounts with one; copied; identical already; conflicts
//       (private kept); empty or no preference; deleted or missing accounts;
//       invalid values dropped. Then seekingPreferences docs losing fields and
//       docs it would back up
//   node scripts/migrate-seeking-prefs.mjs --apply --backup <scratch>/seeking-prefs-backup.json
//       writes; first saves every doc it will change there. That is
//       production data — a scratch path outside the repo, deleted after.
//
// Run --apply after the web app that saves these to private/matching is live
// (until then, saves keep writing seekingPreferences). Each copy fires
// onMatchingPrefsWrite, which re-scores that person's pairs (when a body type
// or height range was copied). Idempotent: a second run finds nothing.
// Credentials: Application Default Credentials.

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { applySeekingPrefs, planSeekingPrefs, summarySeekingPrefs } from './lib/seekingPrefs.mjs'

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

const plan = await planSeekingPrefs({ db })
for (const [k, n] of Object.entries(summarySeekingPrefs(plan))) console.log(`${k.padEnd(72)} ${n}`)
if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
writeFileSync(backupAt, JSON.stringify(plan.backup, null, 1))
console.log(`\nBacked up ${Object.keys(plan.backup).length} docs to ${backupAt}`)
const n = await applySeekingPrefs({ db, FieldValue }, plan)
console.log(`Applied: ${n} writes.`)
process.exit(0)
