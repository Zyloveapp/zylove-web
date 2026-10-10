// Austin-only launch: keep current access for members the change would
// otherwise take it from. Run only once Matthew approves, with the numbers
// from scripts/waitlist-dryrun.mjs.
//
//   (cd functions && npm run build)
//   node scripts/waitlist-keep-access.mjs            dry run: counts only
//   node scripts/waitlist-keep-access.mjs --apply    sets the flag
//
// Credentials: Application Default Credentials.
//
// Who: real members (onboarded, not bots, not deleted, not founders) whose
// saved location is outside every Founding/Live city and who have pre-launch
// Elite today. Sets userInternal/{uid}.keepAccess = true (server-only), which
// keeps their pre-launch Elite (entitlements.ts) and their deck where they
// are (explore.ts). Prints counts only.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()
const { loadCityConfigs, servingCityAt } = require('../functions/lib/cityStatus.js')

const apply = process.argv.includes('--apply')
const configs = await loadCityConfigs()
let checked = 0
let kept = 0
let already = 0
for (const u of (await db.collection('users').get()).docs) {
  const d = u.data()
  if (/^(zbot|seed)-/.test(u.id) || d.isDeleted === true || d.onboardingComplete !== true || d.isFounder === true) continue
  checked++
  const loc = (await db.doc(`userLocations/${u.id}`).get()).data()
  if (typeof loc?.lat !== 'number' || typeof loc?.lng !== 'number' || servingCityAt(loc.lat, loc.lng, configs)) continue
  const internal = (await db.doc(`userInternal/${u.id}`).get()).data()
  if (internal?.entitlement?.source !== 'prelaunch') continue
  if (internal.keepAccess === true) { already++; continue }
  kept++
  if (apply) await db.doc(`userInternal/${u.id}`).set({ keepAccess: true, keepAccessAt: FieldValue.serverTimestamp() }, { merge: true })
}
console.log({ mode: apply ? 'apply' : 'dry run', membersChecked: checked, [apply ? 'flagged' : 'wouldFlag']: kept, alreadyFlagged: already })
