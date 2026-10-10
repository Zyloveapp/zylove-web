// Austin-only launch + city waitlist: who the change would touch. Read-only;
// prints counts only (no ids, names, numbers or coordinates). Production data
// never lands in the repo.
//
//   (cd functions && npm run build)
//   node scripts/waitlist-dryrun.mjs
//
// Credentials: Application Default Credentials.
//
// "Open area" = within the radius of a Founding or Live city. Today that is
// Austin only (every other city starts Locked), plus any city already open.
//   - real members (onboarded, not bots, not deleted) outside every open area,
//     by the city they're nearest to (any distance), and how many of them have
//     pre-launch Elite / a founder spot / a live trial today — the ones the
//     keep-access flag (scripts/waitlist-keep-access.mjs) would cover
//   - members with no saved location
//   - sign-ins with no profile yet (they meet the location check first)

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getAuth } = require('firebase-admin/auth')
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()
const { ZYLOVE_CITIES, distanceMiles } = require('../functions/lib/cities.js')

const isBot = (uid) => /^(zbot|seed)-/.test(uid)
const open = new Set(['austin'])
for (const c of ZYLOVE_CITIES) {
  const d = (await db.doc(`config/city_${c.id}`).get()).data()
  if (d?.discoveryOpenedAt != null || d?.botsActive === false) open.add(c.id)
}
const inOpenArea = (lat, lng) => ZYLOVE_CITIES.some((c) => open.has(c.id) && distanceMiles(lat, lng, c.lat, c.lng) <= c.radiusMiles)
const nearest = (lat, lng) => ZYLOVE_CITIES.reduce((a, c) => (distanceMiles(lat, lng, c.lat, c.lng) < distanceMiles(lat, lng, a.lat, a.lng) ? c : a))

const users = (await db.collection('users').get()).docs
const profiled = new Set(users.map((u) => u.id))
let members = 0
let inside = 0
let noLocation = 0
const outside = {}
for (const u of users) {
  const d = u.data()
  if (isBot(u.id) || d.isDeleted === true || d.deleted === true || d.onboardingComplete !== true) continue
  members++
  const loc = (await db.doc(`userLocations/${u.id}`).get()).data()
  const lat = typeof loc?.lat === 'number' ? loc.lat : d.locationLat
  const lng = typeof loc?.lng === 'number' ? loc.lng : d.locationLng
  if (typeof lat !== 'number' || typeof lng !== 'number') { noLocation++; continue }
  if (inOpenArea(lat, lng)) { inside++; continue }
  const city = nearest(lat, lng).name
  const ent = (await db.doc(`userInternal/${u.id}`).get()).data()?.entitlement
  const row = (outside[city] ??= { members: 0, prelaunchElite: 0, founders: 0, trial: 0, otherPlan: 0, free: 0 })
  row.members++
  if (d.isFounder === true) row.founders++
  else if (ent?.source === 'prelaunch') row.prelaunchElite++
  else if (ent?.source === 'trial') row.trial++
  else if (ent?.tier && ent.tier !== 'free') row.otherPlan++
  else row.free++
}

let noProfile = 0
let page
do {
  const res = await getAuth().listUsers(1000, page)
  for (const a of res.users) if (!isBot(a.uid) && !profiled.has(a.uid)) noProfile++
  page = res.pageToken
} while (page)

console.log({ openCities: [...open], members, insideOpenArea: inside, noLocation, signInsWithoutProfile: noProfile })
console.table(outside)
