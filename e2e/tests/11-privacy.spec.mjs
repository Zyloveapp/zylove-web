import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, callAs, idTokenFor, db, adminAuth, userDoc, internalDoc, PROJECT } from './helpers.mjs'
import { MOVED_FIELDS } from '../../scripts/lib/stage1a.mjs'

test.beforeEach(resetEmulators)

// The Firestore emulator's REST API with a user's ID token: the security
// rules apply exactly as they do to the app.
const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
async function restGet(uid, path) {
  return (await fetch(`${BASE}/${path}`, { headers: { Authorization: `Bearer ${await idTokenFor(uid)}` } })).status
}
const value = (v) =>
  typeof v === 'string' ? { stringValue: v }
  : typeof v === 'number' ? { integerValue: String(v) }
  : typeof v === 'boolean' ? { booleanValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(value) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } }
async function restPatch(uid, path, data) {
  const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&')
  const r = await fetch(`${BASE}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, value(v)])) }),
  })
  return r.status
}

test('privacy: no private field left on the public doc after migration', async () => {
  const a = await seedUser('Ada', {
    smsConsent: { grantedAt: new Date(), phone: '+15550100001' }, smsQuietHours: { enabled: true }, photoAnalysisConsent: { spark: true },
    stripeCustomerId: 'cus_test', subscriptionStatus: 'active', isAdmin: true, geohash: '9v6kp', phoneNumber: '+15550100001',
  })
  const u = await userDoc(a.uid)
  for (const f of MOVED_FIELDS) expect(u[f], f).toBeUndefined()
  expect(u.age).toBe(30) // the public age stays
  expect(u.locationLabel).toBe('Austin, TX')
  const internal = await internalDoc(a.uid)
  expect(internal).toMatchObject({ subscriptionTier: 'free', subscriptionStatus: 'active', stripeCustomerId: 'cus_test', admin: true, reportCount: 0 })
  const account = (await db.doc(`users/${a.uid}/private/account`).get()).data()
  expect(account).toMatchObject({ subscriptionTier: 'free', hasBillingAccount: true, smsConsent: { phone: '+15550100001' } })
  expect(account.location).toMatchObject({ lat: 30.25, lng: -97.75, label: 'Austin, TX', marketCityId: 'austin' })
  expect((await db.doc(`users/${a.uid}/private/settings`).get()).data()).toMatchObject({ smsQuietHours: { enabled: true }, photoAnalysisConsent: { spark: true } })
  expect((await db.doc(`users/${a.uid}/private/identity`).get()).data()).toMatchObject({ birthday: '1995-03-14' })
  expect((await db.doc(`userLocations/${a.uid}`).get()).data()).toMatchObject({ lat: 30.25, lng: -97.75, marketCityId: 'austin' })
  // isAdmin became the auth claim.
  expect((await adminAuth.getUser(a.uid)).customClaims?.admin).toBe(true)
})

test('privacy: another user can read none of my private docs; I can read only my own private/*', async () => {
  const a = await seedUser('Bea')
  const b = await seedUser('Cal')
  for (const path of [`users/${b.uid}/private/account`, `users/${b.uid}/private/settings`, `users/${b.uid}/private/identity`, `userInternal/${b.uid}`, `userLocations/${b.uid}`]) {
    expect(await restGet(a.uid, path), path).toBe(403)
  }
  expect(await restGet(a.uid, `users/${b.uid}`)).toBe(200) // the public profile
  for (const path of [`users/${a.uid}/private/account`, `users/${a.uid}/private/identity`]) expect(await restGet(a.uid, path), path).toBe(200)
  // Server-only even for the owner.
  expect(await restGet(a.uid, `userInternal/${a.uid}`)).toBe(403)
  expect(await restGet(a.uid, `userLocations/${a.uid}`)).toBe(403)
})

test('privacy: clients cannot write moved fields to the public doc, or the plan anywhere', async () => {
  const a = await seedUser('Dee')
  const blocked = {
    subscriptionTier: 'elite', subscriptionStatus: 'active', trialExpired: false, stripeCustomerId: 'cus_x', birthday: '2000-01-01',
    locationLat: 1, smsNotifications: { quietNudge: true }, smsConsent: { phone: '+15550000000' }, lastActive: 1, isAdmin: true,
    photoAnalysisConsent: { spark: true }, phoneNumber: '+15550000000', pendingPhotoURLs: [], expoPushToken: 'x', zyloveScore: { vibePoints: 999 },
    bioGenerations: { play: [] }, likesReceivedCount: 5, age: 22,
  }
  for (const [k, v] of Object.entries(blocked)) expect(await restPatch(a.uid, `users/${a.uid}`, { [k]: v }), k).toBe(403)
  expect(await restPatch(a.uid, `users/${a.uid}`, { bio: 'still editable' })).toBe(200)
  // private/account: server-written, except emptying the photo-review queue.
  expect(await restPatch(a.uid, `users/${a.uid}/private/account`, { subscriptionTier: 'elite' })).toBe(403)
  expect(await restPatch(a.uid, `users/${a.uid}/private/account`, { hasBillingAccount: true })).toBe(403)
  expect(await restPatch(a.uid, `users/${a.uid}/private/account`, { pendingPhotoURLs: ['x'] })).toBe(403)
  expect(await restPatch(a.uid, `users/${a.uid}/private/account`, { pendingPhotoURLs: [] })).toBe(200)
  // private/settings: allow-listed keys only.
  expect(await restPatch(a.uid, `users/${a.uid}/private/settings`, { smsQuietHours: { enabled: false } })).toBe(200)
  expect(await restPatch(a.uid, `users/${a.uid}/private/settings`, { subscriptionTier: 'elite' })).toBe(403)
  expect(await restPatch(a.uid, `users/${a.uid}/private/settings`, { smsConsent: { phone: '+15550000000' } })).toBe(403)
  // private/identity: birthday locked once identity is (seeded locked); legal name set once.
  expect(await restPatch(a.uid, `users/${a.uid}/private/identity`, { birthday: '2001-01-01' })).toBe(403)
  expect(await restPatch(a.uid, `users/${a.uid}/private/identity`, { legalName: 'First' })).toBe(200)
  expect(await restPatch(a.uid, `users/${a.uid}/private/identity`, { legalName: 'Changed' })).toBe(403)
  // Nobody writes another user's private docs or the server-only collections.
  const b = await seedUser('Eve')
  expect(await restPatch(a.uid, `users/${b.uid}/private/settings`, { smsQuietHours: { enabled: false } })).toBe(403)
  expect(await restPatch(a.uid, `userInternal/${a.uid}`, { subscriptionTier: 'elite' })).toBe(403)
  expect(await restPatch(a.uid, `userLocations/${a.uid}`, { lat: 0 })).toBe(403)
})

test('privacy: getDistances returns whole miles and a market flag — never coordinates', async () => {
  const a = await seedUser('Fay')
  const near = await seedUser('Gus', { locationLat: 30.3, locationLng: -97.7 })
  const far = await seedUser('Hal', { locationLat: 32.78, locationLng: -96.8 }) // Dallas
  const none = await seedUser('Ivo')
  await db.doc(`userLocations/${none.uid}`).delete()
  // Stage B: only people the caller can see (here: their Explore deck).
  const stranger = await seedUser('Jon')
  await db.doc(`exploreState/${a.uid}`).set({ spark: { deck: [near.uid, far.uid, none.uid] } }, { merge: true })
  const { distances } = await callAs(a.uid, 'getDistances', { uids: [near.uid, far.uid, none.uid, a.uid, stranger.uid] })
  expect(Object.keys(distances).sort()).toEqual([far.uid, near.uid].sort())
  expect(Object.keys(distances[near.uid]).sort()).toEqual(['miles', 'sameMarket'])
  expect(Number.isInteger(distances[near.uid].miles)).toBe(true)
  expect(distances[near.uid]).toMatchObject({ sameMarket: true })
  expect(distances[far.uid].sameMarket).toBe(false)
  expect(distances[far.uid].miles).toBe(51) // "50+ miles" (Stage 3 coarse labels)
  await expect(callAs(a.uid, 'getDistances', { uids: Array.from({ length: 201 }, (_, i) => `u${i}`) })).rejects.toThrow(/invalid-argument|INVALID_ARGUMENT/)
})

test('location: setLocation snaps, labels, locks the market, and allows 3 moves a day', async () => {
  const a = await seedUser('Jay')
  // ~1-mile grid (Stage 3): the saved 3-mile point is off-grid, so the first save is a move.
  const snap = (v) => Math.round(Math.round(v / 0.015) * 0.015 * 1000) / 1000
  expect(await callAs(a.uid, 'setLocation', { lat: 30.4, lng: -97.7 })).toMatchObject({ changed: true, label: 'Austin, TX' })
  // Same grid cell: nothing changes, nothing counted.
  expect(await callAs(a.uid, 'setLocation', { lat: 30.4 + 0.002, lng: -97.7 + 0.002 })).toMatchObject({ changed: false })
  for (const [lat, lng] of [[30.5, -97.7], [32.78, -96.8]]) expect(await callAs(a.uid, 'setLocation', { lat, lng })).toMatchObject({ changed: true }) // the last is Dallas
  const loc = (await db.doc(`userLocations/${a.uid}`).get()).data()
  expect(loc).toMatchObject({ lat: snap(32.78), lng: snap(-96.8), marketCityId: 'austin' }) // market stays locked to Austin
  await expect(callAs(a.uid, 'setLocation', { lat: 30.25, lng: -97.75 })).rejects.toThrow(/You can update your location again tomorrow/)
  const u = await userDoc(a.uid)
  expect(u.locationLat).toBeUndefined()
  await expect(callAs(a.uid, 'setLocation', { lat: 'x', lng: 1 })).rejects.toThrow(/invalid-argument|INVALID_ARGUMENT/)
})

test('admin: the claim gates admin callables; the old isAdmin field does nothing', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const user = await seedUser('Lee')
  await db.doc(`users/${user.uid}`).update({ isAdmin: true }) // a stale/forged field
  await expect(callAs(user.uid, 'adminGetReports', { summaryOnly: true })).rejects.toThrow(/permission-denied|PERMISSION_DENIED/)
  await expect(callAs(admin.uid, 'adminGetReports', { summaryOnly: true })).resolves.toBeTruthy()
})
