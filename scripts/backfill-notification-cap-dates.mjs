// F-085: notificationCaps/{uid}_{YYYY-MM-DD} written before
// incrementMessageCap stamped updatedAt have no date, so purgeRetention
// counts them as "undated" and never deletes them. This dates each one by
// the day in its id (the end of that UTC day — retention.ts
// notificationCapDay), after which the nightly purge removes those past
// 2 years like any other.
//
//   (cd functions && npm run build)                 uses functions/lib/retention.js
//   node scripts/backfill-notification-cap-dates.mjs                 dry run (default): counts only
//   node scripts/backfill-notification-cap-dates.mjs --out <file>    dry run, plus the counts as JSON in <file>
//   node scripts/backfill-notification-cap-dates.mjs --apply         writes updatedAt on the undated docs
//
// Read-only unless --apply. Prints counts only (no ids, no uids). Idempotent:
// a doc that already has a Timestamp updatedAt is skipped. --out should be a
// scratch path outside the repo. Credentials: Application Default Credentials.

import { createRequire } from 'node:module'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/backfill-notification-cap-dates.mjs [--out <file>] [--apply]   (dry run by default; build functions first)')
  process.exit(0)
}
const apply = args.includes('--apply')
const outAt = args.indexOf('--out')
const out = outAt >= 0 ? args[outAt + 1] : null
if (outAt >= 0 && !out) {
  console.error('--out needs a file path.')
  process.exit(1)
}
const lib = new URL('../functions/lib/retention.js', import.meta.url)
if (!existsSync(lib)) {
  console.error('functions/lib/retention.js not found — run (cd functions && npm run build) first.')
  process.exit(1)
}
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { getFirestore, Timestamp } = require('firebase-admin/firestore')
const { notificationCapDay, RETENTION } = require(fileURLToPath(lib))

initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()
const maxAgeMs = RETENTION.find((e) => e.collection === 'notificationCaps').maxAgeMs
const cutoff = Date.now() - maxAgeMs

const counts = { total: 0, alreadyDated: 0, undated: 0, datable: 0, undatable: 0, pastRetention: 0, written: 0, byMonth: {} }
let batch = db.batch()
let pending = 0
let last = null
for (;;) {
  let q = db.collection('notificationCaps').orderBy('__name__').limit(500)
  if (last) q = q.startAfter(last)
  const page = await q.get()
  if (page.empty) break
  last = page.docs[page.docs.length - 1]
  for (const d of page.docs) {
    counts.total++
    if (d.get('updatedAt') instanceof Timestamp) {
      counts.alreadyDated++
      continue
    }
    counts.undated++
    const day = notificationCapDay(d.id)
    if (day === null) {
      counts.undatable++
      continue
    }
    counts.datable++
    if (day < cutoff) counts.pastRetention++
    const month = new Date(day).toISOString().slice(0, 7)
    counts.byMonth[month] = (counts.byMonth[month] ?? 0) + 1
    if (apply) {
      batch.update(d.ref, { updatedAt: Timestamp.fromMillis(day) })
      if (++pending === 400) {
        await batch.commit()
        counts.written += pending
        batch = db.batch()
        pending = 0
      }
    }
  }
  if (page.size < 500) break
}
if (apply && pending) {
  await batch.commit()
  counts.written += pending
}

console.log(JSON.stringify(counts, null, 2))
if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), apply, ...counts }, null, 2))
console.log(apply ? `\nDated ${counts.written} docs.` : '\nDry run — nothing written to Firestore.')
process.exit(0)
