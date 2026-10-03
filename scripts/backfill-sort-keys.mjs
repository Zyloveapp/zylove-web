// One-time: give every users/{uid} doc without a sortKey a random one (0–1),
// so the whole pool is reachable by the Explore query's random start point.
// New and active users get one automatically (initUserDefaults, and the
// ensureSortKey trigger on their next write); this catches everyone else now.
//
//   node scripts/backfill-sort-keys.mjs          dry run: count what's missing
//   node scripts/backfill-sort-keys.mjs --apply  write the missing keys
//
// Never changes an existing sortKey. Credentials: the service account below if
// present, otherwise Application Default Credentials
// (gcloud auth application-default login).

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const apply = process.argv.includes('--apply')
const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
initializeApp({ credential, projectId: 'zylove' })
const db = getFirestore()

const users = await db.collection('users').select('sortKey').get()
const missing = users.docs.filter((d) => typeof d.data().sortKey !== 'number')
console.log(`${users.size} users, ${missing.length} without a sortKey`)
if (!apply) {
  console.log('Dry run — re-run with --apply to write them.')
  process.exit(0)
}
for (let i = 0; i < missing.length; i += 400) {
  const batch = db.batch()
  for (const d of missing.slice(i, i + 400)) batch.update(d.ref, { sortKey: Math.random() })
  await batch.commit()
}
console.log(`Wrote ${missing.length} sortKeys.`)
