// One-time privacy stopgap: delete `_location` (raw GPS, written by the
// mobile app and the bot seeder) and `geohash` (~150 m) from every user doc
// and from their sparkProfile / playProfile docs. Any signed-in user can read
// these docs. The web's snapped locationLat / locationLng (~3 miles) and
// locationLabel are left alone. Real users and bots alike.
//
// Bots' _location is their city centre (seed-city-bots.mjs), the only place
// they keep coordinates; a bot without locationLat gets that city centre as
// locationLat / locationLng first, so its city label keeps working.
//
//   node scripts/scrub-raw-location.mjs --dry-run   list docs and fields
//   node scripts/scrub-raw-location.mjs --apply     delete them
//
// Back up first (gcloud firestore export). Credentials: Application Default
// Credentials (gcloud auth application-default login).

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()

const FIELDS = ['_location', 'geohash']
const isBot = (path) => /users\/(zbot-|seed-)/.test(path)
const precision = (v) => {
  if (typeof v === 'string') return v ? `${v.length}-char` : 'empty'
  const lat = v?.latitude ?? v?._latitude
  return typeof lat === 'number' ? `${(String(lat).split('.')[1] ?? '').length} dp` : typeof v
}

const docs = [
  ...(await db.collection('users').get()).docs,
  ...(await db.collectionGroup('sparkProfile').get()).docs,
  ...(await db.collectionGroup('playProfile').get()).docs,
]
const affected = docs
  .map((d) => ({ ref: d.ref, fields: FIELDS.filter((f) => d.get(f) !== undefined), data: d.data() }))
  .filter((r) => r.fields.length > 0)
// Bot user docs: city centre from _location, when they have no locationLat.
const cityCentre = (r) => {
  const g = r.data._location
  return isBot(r.ref.path) && r.ref.path.split('/').length === 2 && typeof r.data.locationLat !== 'number' &&
    typeof g?.latitude === 'number' && typeof g?.longitude === 'number'
    ? { locationLat: g.latitude, locationLng: g.longitude }
    : null
}

const real = affected.filter((r) => !isBot(r.ref.path))
const bots = affected.filter((r) => isBot(r.ref.path))
console.log(`Scanned ${docs.length} docs (users + sparkProfile + playProfile). ${affected.length} hold ${FIELDS.join(' / ')}.`)
console.log(`\nReal users: ${real.length} docs`)
for (const r of real) {
  console.log(`  ${r.ref.path.replace(/users\/(\w{6})\w*/, 'users/$1…')}  ${r.fields.map((f) => `${f} (${precision(r.data[f])})`).join(', ')}`)
}
console.log(`\nBots: ${bots.length} docs`)
const summary = {}
for (const r of bots) for (const f of r.fields) summary[`${r.ref.path.split('/').length > 2 ? r.ref.path.split('/')[2] : 'users'}.${f}`] = (summary[`${r.ref.path.split('/').length > 2 ? r.ref.path.split('/')[2] : 'users'}.${f}`] ?? 0) + 1
for (const [k, n] of Object.entries(summary)) console.log(`  ${k}: ${n}`)
const centres = bots.filter(cityCentre)
const byCity = {}
for (const r of centres) byCity[r.data.locationLabel ?? '?'] = (byCity[r.data.locationLabel ?? '?'] ?? 0) + 1
console.log(`  + city centre copied to locationLat/locationLng first: ${centres.length} bots (${Object.entries(byCity).map(([c, n]) => `${c} ${n}`).join(', ')})`)

if (!apply) {
  console.log('\nDry run — nothing deleted. Re-run with --apply to delete these fields.')
  process.exit(0)
}

for (let i = 0; i < affected.length; i += 450) {
  const batch = db.batch()
  for (const r of affected.slice(i, i + 450)) {
    batch.update(r.ref, { ...cityCentre(r), ...Object.fromEntries(r.fields.map((f) => [f, FieldValue.delete()])) })
  }
  await batch.commit()
}
console.log(`\nDeleted ${FIELDS.join(' / ')} from ${affected.length} docs.`)
