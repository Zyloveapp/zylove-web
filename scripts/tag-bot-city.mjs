// Bots (zbot-* users) only show in Explore for viewers in the same city as
// their locationLabel. seedProfiles sets "Austin, TX"; this checks every bot
// has one and fills in any that don't.
//
//   node scripts/tag-bot-city.mjs          dry run: list bots and their labels
//   node scripts/tag-bot-city.mjs --apply  set "Austin, TX" where it's missing
//
// Never overwrites an existing label. Credentials as in backfill-sort-keys.mjs.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { FieldPath, getFirestore } = require('firebase-admin/firestore')

const LABEL = 'Austin, TX'
const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const apply = process.argv.includes('--apply')
const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
initializeApp({ credential, projectId: 'zylove' })
const db = getFirestore()

// '.' sorts right after '-', so this range is exactly the zbot- ids.
const bots = await db
  .collection('users')
  .where(FieldPath.documentId(), '>=', 'zbot-')
  .where(FieldPath.documentId(), '<', 'zbot.')
  .select('locationLabel')
  .get()

const counts = {}
for (const d of bots.docs) {
  const label = d.data().locationLabel || '(none)'
  counts[label] = (counts[label] ?? 0) + 1
}
const unlabeled = bots.docs.filter((d) => !d.data().locationLabel)
console.log(`${bots.size} bots by locationLabel:`, counts)
if (!apply || unlabeled.length === 0) {
  if (unlabeled.length) console.log(`Dry run — re-run with --apply to set "${LABEL}" on ${unlabeled.length}.`)
  process.exit(0)
}
const batch = db.batch()
for (const d of unlabeled) batch.update(d.ref, { locationLabel: LABEL })
await batch.commit()
console.log(`Set "${LABEL}" on ${unlabeled.length} bots.`)
