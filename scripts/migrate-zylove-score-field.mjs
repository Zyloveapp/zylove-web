// One-time: move users/{uid}.zylovScore.* (a misspelling, still written by
// the mobile app's client) into users/{uid}.zyloveScore.*, adding to whatever
// is already there, then delete the old map. Readers sum both fields, so
// anything mobile writes to the old name afterwards still counts.
//
//   node scripts/migrate-zylove-score-field.mjs --dry-run  count what would move
//   node scripts/migrate-zylove-score-field.mjs --apply    move it
//
// Numeric fields (vibePoints, participationPoints, vibeCheckCount) are added;
// anything else (e.g. lastUpdated) is copied only if the new map lacks it.
// Each user is moved in its own transaction, so a concurrent increment is
// never lost. Credentials: the service account below if present, otherwise
// Application Default Credentials (gcloud auth application-default login).

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')

const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const apply = process.argv.includes('--apply')
const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
initializeApp({ credential, projectId: 'zylove' })
const db = getFirestore()

const users = await db.collection('users').orderBy('zylovScore').select('zylovScore').get()
console.log(`${users.size} users with a zylovScore map`)
if (!apply) {
  for (const d of users.docs.slice(0, 5)) console.log(`  e.g. ${d.id.slice(0, 6)}…`, JSON.stringify(d.data().zylovScore))
  console.log('Dry run — re-run with --apply to move them.')
  process.exit(0)
}

let moved = 0
for (const d of users.docs) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(d.ref)
    const old = snap.data()?.zylovScore
    if (!old || typeof old !== 'object') return
    const current = snap.data()?.zyloveScore ?? {}
    const update = { zylovScore: FieldValue.delete() }
    for (const [key, value] of Object.entries(old)) {
      if (typeof value === 'number') update[`zyloveScore.${key}`] = FieldValue.increment(value)
      else if (current[key] === undefined) update[`zyloveScore.${key}`] = value
    }
    tx.update(d.ref, update)
  })
  moved++
}
const left = await db.collection('users').orderBy('zylovScore').count().get()
console.log(`Moved ${moved}. ${left.data().count} still have a zylovScore map.`)
