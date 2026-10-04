// Founders with no founderBadge get "Austin Founder". These are mobile
// founder-code founders (redeemFounderCode never set one); every founder from
// before city circles is Austin. FounderBadge.tsx already falls back to the
// same label, so this only makes the stored data match what's shown.
//
//   node scripts/backfill-founder-badges.mjs --dry-run
//   node scripts/backfill-founder-badges.mjs --apply
//
// Never overwrites an existing founderBadge. Credentials as in init-cities.mjs.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

const BADGE = 'Austin Founder'
const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply')
  process.exit(1)
}
const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
initializeApp({ credential, projectId: 'zylove' })
const db = getFirestore()

// Firestore can't query for a missing field, so filter here.
const founders = await db.collection('users').where('isFounder', '==', true).select('founderBadge').get()
const missing = founders.docs.filter((d) => {
  const badge = d.data().founderBadge
  return typeof badge !== 'string' || badge === ''
})

for (const d of missing) {
  console.log(`${apply ? 'set' : 'would set'} ${d.id}: founderBadge "${BADGE}"`)
  if (apply) await d.ref.update({ founderBadge: BADGE })
}
console.log(`\n${founders.size} founders · ${missing.length} ${apply ? 'updated' : 'to update'}`)
