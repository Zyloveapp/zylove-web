// §4.A3 anonymous likers: opaque like ids on existing like queue docs, and
// (F-098) the score details off them. See scripts/lib/a3Likes.mjs.
//
//   node scripts/migrate-a3-likes.mjs --dry-run
//       counts only (no names, ids or content): like queue docs per mode,
//       ones that already have a like id, like ids to add per mode, likes
//       skipped as hidden (per mode and reason: liker deleted or gone,
//       suspended, blocked, out of Play), docs losing breakdown /
//       dealbreakersTriggered
//   node scripts/migrate-a3-likes.mjs --apply --backup <scratch>/a3-likes-backup.json
//
// --apply needs --backup: every doc it will change is saved there first
// (path → its likeId / breakdown / dealbreakersTriggered as they were). That
// is production data — a scratch path outside the repo, deleted after.
//
// Optional and safe to run any time after the §4.A3 functions are live:
// getLikes gives a like id on demand to any doc without one, so old and new
// docs work side by side. Nothing is re-keyed or deleted. Idempotent.
// Credentials: Application Default Credentials.

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { applyA3Likes, planA3Likes, summary } from './lib/a3Likes.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
const backupAt = process.argv.includes('--backup') ? process.argv[process.argv.indexOf('--backup') + 1] : null
if (apply && !backupAt) {
  console.error('--apply needs --backup <scratch file>.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()

const plan = await planA3Likes({ db })
for (const [k, n] of Object.entries(summary(plan))) console.log(`${k.padEnd(64)} ${n}`)
if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
writeFileSync(backupAt, JSON.stringify(plan.backup, null, 1))
console.log(`\nBacked up ${Object.keys(plan.backup).length} docs to ${backupAt}`)
const n = await applyA3Likes({ db, FieldValue }, plan)
console.log(`Applied: ${n} docs updated.`)
process.exit(0)
