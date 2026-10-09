import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, callAs, idTokenFor, db, fnLib, FieldValue, userDoc, PROJECT } from './helpers.mjs'
import { planStage3, applyStage3 } from '../../scripts/lib/stage3.mjs'

test.beforeEach(resetEmulators)

const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
const auth = async (uid) => ({ Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' })
const restGet = async (uid, path) => (await fetch(`${BASE}/${path}`, { headers: await auth(uid) })).status
const value = (v) =>
  v === null ? { nullValue: null }
  : typeof v === 'string' ? { stringValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'boolean' ? { booleanValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(value) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } }
async function restPatch(uid, path, data, mask = Object.keys(data)) {
  const q = mask.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&')
  return (await fetch(`${BASE}/${path}?${q}`, {
    method: 'PATCH', headers: await auth(uid),
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, value(v)])) }),
  })).status
}

const deck = (uid, mode = 'spark') => callAs(uid, 'getExploreDeck', { mode })
const uidsOf = (r) => r.cards.map((c) => c.uid).sort()
const woman = (name, o = {}) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o })

test('explore: deck honours attraction, age range, blocks, suspension and deletion', async () => {
  const me = await seedUser('Max')
  const ok = await woman('Wren')
  await seedUser('Moe') // a man who wants women — not who Max wants
  await woman('Lia', { attractedTo: ['women'] }) // doesn't want Max
  await woman('Old', { age: 60 }) // outside Max's 21–45
  const blocked = await woman('Bel')
  const susp = await woman('Sue')
  const del = await woman('Dee')
  await fnLib('explore').setBlocked(me.uid, blocked.uid, true)
  await db.doc(`userInternal/${susp.uid}`).set({ isSuspended: true }, { merge: true })
  await db.doc(`users/${del.uid}`).update({ isDeleted: true })
  for (const u of [susp, del]) await fnLib('explore').refreshEntry(u.uid)
  const r = await deck(me.uid)
  expect(uidsOf(r)).toEqual([ok.uid])
  // A card carries the public profile, a coarse distance and no private fields.
  const card = r.cards[0]
  expect(card.distanceMiles).toBe(0)
  for (const f of ['attractedTo', 'ageMin', 'ageMax', 'radiusMiles', 'isSuspended', 'birthday', 'locationLat', 'locationLng']) expect(card.profile[f], f).toBeUndefined()
  expect((await db.doc(`exploreIndex/${ok.uid}`).get()).exists).toBe(true)
  for (const u of [susp, del]) expect((await db.doc(`exploreIndex/${u.uid}`).get()).exists).toBe(false)
})

test('explore anti-scrape: repeated calls return the same cards; the deck advances only as you swipe', async () => {
  test.setTimeout(240_000)
  const me = await seedUser('Max')
  for (let i = 0; i < 26; i++) await woman(`W${i}`)
  const first = await deck(me.uid)
  expect(first.cards).toHaveLength(20)
  const seen = new Set(uidsOf(first))
  for (let i = 0; i < 6; i++) {
    const again = await deck(me.uid)
    expect(uidsOf(again)).toEqual(uidsOf(first)) // nothing new without swiping
  }
  // Swipe 3 → exactly 3 new people.
  const swiped = uidsOf(first).slice(0, 3)
  for (const [i, t] of swiped.entries()) await callAs(me.uid, 'recordSwipe', { targetUid: t, action: i ? 'pass' : 'like', mode: 'spark' })
  const next = await deck(me.uid)
  expect(next.cards).toHaveLength(20)
  for (const t of swiped) expect(uidsOf(next)).not.toContain(t)
  const fresh = uidsOf(next).filter((u) => !seen.has(u))
  expect(fresh).toHaveLength(3)
  for (const u of fresh) seen.add(u)
  // Rapid repeats again reveal nothing.
  for (let i = 0; i < 5; i++) for (const u of uidsOf(await deck(me.uid))) expect(seen.has(u)).toBe(true)
  // Profiles revealed = the first deck + one per swipe; counted server-side.
  expect(seen.size).toBe(23)
  expect((await db.doc(`rateLimits/${me.uid}`).get()).data().exploreNew).toHaveLength(23)
})

test('explore anti-scrape: per-user caps — burst, daily calls, daily new profiles', async () => {
  test.setTimeout(180_000)
  const me = await seedUser('Max')
  const others = []
  for (let i = 0; i < 6; i++) others.push(await woman(`W${i}`))
  // Daily new-profile cap: 497 already revealed today → only 3 more, and swiping doesn't refill past it.
  const now = Date.now()
  await db.doc(`rateLimits/${me.uid}`).set({ exploreNew: Array.from({ length: 497 }, () => now) })
  const r = await deck(me.uid)
  expect(r.cards).toHaveLength(3)
  expect(uidsOf(await deck(me.uid))).toEqual(uidsOf(r))
  await callAs(me.uid, 'recordSwipe', { targetUid: r.cards[0].uid, action: 'pass', mode: 'spark' })
  expect(uidsOf(await deck(me.uid))).toEqual(uidsOf(r).filter((u) => u !== r.cards[0].uid))
  // Daily call cap (150).
  await db.doc(`rateLimits/${me.uid}`).set({ exploreDay: Array.from({ length: 150 }, () => now), exploreBurst: [] })
  await expect(deck(me.uid)).rejects.toThrow(/resource-exhausted|RESOURCE_EXHAUSTED|Too many/)
  // Burst cap (30 per 10 minutes).
  await db.doc(`rateLimits/${me.uid}`).set({ exploreDay: [], exploreBurst: Array.from({ length: 29 }, () => now) })
  await deck(me.uid)
  await expect(deck(me.uid)).rejects.toThrow(/resource-exhausted|RESOURCE_EXHAUSTED|Too many/)
  // Signed out: refused.
  const anon = await fetch(`http://127.0.0.1:5311/${PROJECT}/us-central1/getExploreDeck`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":{}}' })
  expect((await anon.json()).error?.status).toBe('UNAUTHENTICATED')
})

test('rules: no listing users; suspended and deleted profiles unreadable', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const s = await woman('Sue')
  const d = await woman('Dee')
  await db.doc(`userInternal/${s.uid}`).set({ isSuspended: true }, { merge: true })
  await db.doc(`users/${d.uid}`).update({ isDeleted: true })
  // List (GET on the collection) and a query both refused.
  expect(await restGet(a.uid, 'users')).toBe(403)
  const q = await fetch(`${BASE}:runQuery`, { method: 'POST', headers: await auth(a.uid), body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'users' }], limit: 5 } }) })
  expect(q.status).toBe(403)
  expect(await restGet(a.uid, `users/${b.uid}`)).toBe(200)
  // F-075: sparkProfile is the owner's only now.
  expect(await restGet(a.uid, `users/${b.uid}/sparkProfile/data`)).toBe(403)
  expect(await restGet(b.uid, `users/${b.uid}/sparkProfile/data`)).toBe(200)
  for (const u of [s, d]) {
    expect(await restGet(a.uid, `users/${u.uid}`), u.name).toBe(403)
    expect(await restGet(a.uid, `users/${u.uid}/sparkProfile/data`), u.name).toBe(403)
  }
  // The owner still reads their own suspended profile.
  expect(await restGet(s.uid, `users/${s.uid}`)).toBe(200)
  // Server-only Explore collections.
  for (const p of [`exploreIndex/${b.uid}`, `exploreState/${a.uid}`]) expect(await restGet(a.uid, p), p).toBe(403)
  // Account state isn't on the public doc, nor writable there.
  expect(await restPatch(a.uid, `users/${a.uid}`, { isSuspended: false })).toBe(403)
  expect(await restPatch(a.uid, `users/${a.uid}`, { attractedTo: ['everyone'] })).toBe(403)
  for (const f of ['dealbreakers', 'seekingTraits', 'adminNotice']) expect(await restPatch(a.uid, `users/${a.uid}`, { [f]: ['x'] }), f).toBe(403)
})

test('rules: private/matching owner-only; matchableAs identity-locked; adminNotice.seenAt only', async () => {
  const a = await seedUser('Ann')
  const b = await seedUser('Bob')
  const path = `users/${a.uid}/private/matching`
  expect(await restGet(a.uid, path)).toBe(200)
  expect(await restGet(b.uid, path)).toBe(403)
  expect(await restPatch(b.uid, path, { radiusMiles: 5 })).toBe(403)
  expect(await restPatch(a.uid, path, { radiusMiles: 10, ageMin: 25, attractedTo: ['everyone'] })).toBe(200)
  // Stage C: 1–100 miles only — no "no limit", nothing outside the range.
  expect(await restPatch(a.uid, path, { radiusMiles: null })).toBe(403)
  expect(await restPatch(a.uid, path, { radiusMiles: 0 })).toBe(403)
  expect(await restPatch(a.uid, path, { radiusMiles: 101 })).toBe(403)
  expect(await restPatch(a.uid, path, { radiusMiles: 100 })).toBe(200)
  expect(await restPatch(a.uid, path, { ageMin: 'x' })).toBe(403)
  expect(await restPatch(a.uid, path, { isSuspended: false })).toBe(403) // unknown key
  expect(await restPatch(a.uid, path, { matchableAs: ['women'] })).toBe(403) // identity locked
  // Unlocked: no gender yet (§4.A2: a gender in private/matching locks
  // identity again at once — identityGuard).
  await db.doc(path).update({ genderIdentity: FieldValue.delete() })
  await db.doc(`users/${a.uid}`).update({ identityLockedAt: FieldValue.delete() })
  expect(await restPatch(a.uid, path, { matchableAs: ['women'] })).toBe(200)
  // The preference change reaches the index.
  await expect.poll(async () => (await db.doc(`exploreIndex/${a.uid}`).get()).data()?.attractedTo, { timeout: 15_000 }).toEqual(['everyone'])

  // Moderation notice: the owner may only mark it seen.
  const acct = `users/${a.uid}/private/account`
  await db.doc(acct).set({ adminNotice: { kind: 'warning', message: 'Be kind', sentAt: 1 } }, { merge: true })
  expect(await restPatch(a.uid, acct, { adminNotice: { seenAt: 2 } }, ['adminNotice.seenAt'])).toBe(200)
  expect(await restPatch(a.uid, acct, { adminNotice: { message: 'edited' } }, ['adminNotice.message'])).toBe(403)
  expect(await restGet(b.uid, acct)).toBe(403)
})

test('location: coarse distance buckets and the ~1-mile grid', async () => {
  const { bucketMiles } = fnLib('location')
  const cases = [[0.2, 0], [0.99, 0], [1.2, 1], [3.6, 4], [10, 10], [10.2, 15], [23, 25], [50, 50], [50.1, 51], [900, 51]]
  for (const [m, b] of cases) expect(bucketMiles(m), String(m)).toBe(b)
  const a = await seedUser('Ann')
  const near = await seedUser('Ned', { locationLat: 30.30, locationLng: -97.75 })
  // Seeded locations keep the old 3-mile grid (as existing users do): 0.05° ≈ 3.5 mi.
  await db.doc(`exploreState/${a.uid}`).set({ spark: { deck: [near.uid] } }, { merge: true }) // visible to them (Stage B)
  const { distances } = await callAs(a.uid, 'getDistances', { uids: [near.uid] })
  expect(distances[near.uid].miles).toBe(3)
})

test('migration: Stage 3 moves preferences and account state, builds already-seen, is idempotent', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const c = await woman('Cat')
  const d = await woman('Dot')
  // Put the old layout back on Ann's docs.
  await db.doc(`users/${a.uid}`).update({
    attractedTo: ['women'], ageMin: 22, ageMax: 40, radiusMiles: 30, drinkingHabit: 'socially',
    isSuspended: true, suspendedAt: 123, suspendReason: 'test', adminNotice: { kind: 'warning', message: 'hi' },
  })
  await db.doc(`users/${a.uid}/private/matching`).delete()
  await db.doc(`userInternal/${a.uid}`).update({ isSuspended: false }) // the default doesn't mask the suspension
  await db.doc(`users/${a.uid}/sparkProfile/data`).update({ attractedTo: ['women'], radiusMiles: 30, ageMin: 22 })
  await db.collection('swipes').add({ swiperId: a.uid, swipedId: b.uid, mode: 'spark', action: 'pass', timestamp: 5 })
  await db.collection('matches').add({ users: [a.uid, c.uid], mode: 'play', matchedAt: 6 })
  await db.doc(`users/${d.uid}/blockedUsers/${a.uid}`).set({ at: 7 })

  const { buildEntry } = fnLib('explore')
  const plan = await planStage3(db)
  expect(plan.users.map((u) => u.uid)).toContain(a.uid)
  await applyStage3({ db, FieldValue }, plan, buildEntry)

  const u = await userDoc(a.uid)
  for (const f of ['attractedTo', 'ageMin', 'ageMax', 'radiusMiles', 'drinkingHabit', 'isSuspended', 'suspendedAt', 'suspendReason', 'adminNotice']) expect(u[f], f).toBeUndefined()
  expect((await db.doc(`users/${a.uid}/private/matching`).get()).data()).toMatchObject({ attractedTo: ['women'], ageMin: 22, ageMax: 40, radiusMiles: 30, drinkingHabit: 'socially' })
  expect((await db.doc(`userInternal/${a.uid}`).get()).data()).toMatchObject({ isSuspended: true, suspendedAt: 123, suspendReason: 'test' })
  expect((await db.doc(`users/${a.uid}/private/account`).get()).data().adminNotice).toMatchObject({ message: 'hi' })
  const sp = (await db.doc(`users/${a.uid}/sparkProfile/data`).get()).data()
  for (const f of ['attractedTo', 'radiusMiles', 'ageMin']) expect(sp[f], f).toBeUndefined()
  const st = (await db.doc(`exploreState/${a.uid}`).get()).data()
  expect(st.spark.acted).toEqual([b.uid])
  expect(st.play.acted).toEqual([c.uid])
  expect(st.blocked).toEqual([d.uid])
  expect((await db.doc(`exploreState/${d.uid}`).get()).data().blocked).toEqual([a.uid])
  // Suspended → out of the index; others in.
  expect((await db.doc(`exploreIndex/${a.uid}`).get()).exists).toBe(false)
  expect((await db.doc(`exploreIndex/${b.uid}`).get()).exists).toBe(true)

  // Idempotent: nothing left to move.
  const again = await planStage3(db)
  expect(again.users).toEqual([])
  expect(again.subdocs).toEqual([])
})
