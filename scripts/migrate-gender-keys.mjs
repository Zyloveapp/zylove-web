// H2 (fresh-eyes review): stored genders rewritten to the app's keys, so
// identity Elite, the founding circle, Explore and scoring all read the same
// thing. See scripts/lib/genderKeys.mjs.
//
//   (cd functions && npm run build)
//   node scripts/migrate-gender-keys.mjs --dry-run
//       counts only (no names, ids or contact details): each stored value →
//       its key, per place (private/matching, old public-doc copies,
//       deletedAccounts); values with no key; accounts whose identity Elite
//       or Explore category changes; founders whose recorded bucket differs;
//       entitlements to recompute; docs it would back up
//   node scripts/migrate-gender-keys.mjs --apply --backup <scratch>/gender-keys-backup.json
//       writes; first saves every doc it will change there. That is
//       production data — a scratch path outside the repo, deleted after.
//
// Run --apply after the H2 functions are live, before the H2 rules (the
// rules then refuse any other spelling on a gender change; an older value
// already stored doesn't block other saves, but should be gone). Idempotent:
// a second run finds nothing. Credentials: Application Default Credentials.

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { applyGenderKeys, planGenderKeys, summaryGenderKeys } from './lib/genderKeys.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

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

const plan = await planGenderKeys({ db })
console.log('Stored values (place: value → key):')
for (const [k, n] of Object.entries(plan.values).sort()) console.log(`  ${k.padEnd(70)} ${n}`)
console.log('')
for (const [k, n] of Object.entries(summaryGenderKeys(plan))) console.log(`${k.padEnd(72)} ${n}`)
if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
writeFileSync(backupAt, JSON.stringify(plan.backup, null, 1))
console.log(`\nBacked up ${Object.keys(plan.backup).length} docs to ${backupAt}`)
const n = await applyGenderKeys({ db }, plan)
console.log(`Applied: ${n} writes; ${plan.refresh.length} entitlements recomputed.`)
process.exit(0)
