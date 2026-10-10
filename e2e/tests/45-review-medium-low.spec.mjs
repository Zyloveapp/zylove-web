// Fresh-eyes review, Medium and Low fixes (F-112 – F-125). Each test is the
// attack, run end to end: it succeeds on the review-fixes base and is
// refused here. M2 (CSP) is a config guard — functions/test/csp.test.ts.
import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, fnLib, sortedPair, PROJECT, setPlan,
  internalDoc, userDoc, FieldValue, Timestamp, playIdOf, phoneFor,
} from './helpers.mjs'

test.beforeEach(resetEmulators)

const DOCS = `projects/${PROJECT}/databases/(default)/documents`
const BASE = `http://127.0.0.1:8390/v1/${DOCS}`
const headers = async (uid) => ({ Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' })
const value = (v) =>
  v === null ? { nullValue: null }
  : typeof v === 'string' ? { stringValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'boolean' ? { booleanValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(value) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } }
const fields = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, value(v)]))
const restPatch = async (uid, path, data) =>
  (await fetch(`${BASE}/${path}?${Object.keys(data).map((k) => `updateMask.fieldPaths=${k}`).join('&')}`, { method: 'PATCH', headers: await headers(uid), body: JSON.stringify({ fields: fields(data) }) })).status
async function sendAs(uid, matchId, data = { messageType: 'text', ciphertext: 'aGVsbG8=', nonce: 'bm9uY2U=' }) {
  const r = await fetch(`${BASE}:commit`, {
    method: 'POST',
    headers: await headers(uid),
    body: JSON.stringify({
      writes: [{
        update: { name: `${DOCS}/matches/${matchId}/messages/m${Math.random().toString(36).slice(2)}`, fields: fields({ senderId: uid, status: 'sent', ...data }) },
        currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'sentAt', setToServerValue: 'REQUEST_TIME' }],
      }],
    }),
  })
  return r.status
}
const errOf = (p) => p.then(() => null, (e) => String(e.message))
const woman = (name, o = {}, opts) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o }, opts)
async function matchOf(a, b) {
  await likeAs(a.uid, b.uid)
  expect((await likeAs(b.uid, a.uid)).matched).toBe(true)
  return sortedPair(a.uid, b.uid)
}
const daysOld = (uid, days) => db.doc(`userInternal/${uid}`).set({ accountCreatedAt: Date.now() - days * 864e5 }, { merge: true })
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms))

// ─── M1 (F-112) ──────────────────────────────────────────────────────────────

test('M1: contact details in a bio or Play prompt are masked; the city label is the server\'s', async () => {
  const a = await seedUser('Ann')
  // A raw client write (the app's editor would refuse it first).
  expect(await restPatch(a.uid, `users/${a.uid}`, { bio: 'dm me on telegram @scam_handle or 512 555 0123' })).toBe(200)
  await expect.poll(async () => (await userDoc(a.uid)).bio, { timeout: 20000 }).toContain('•••')
  const bio = (await userDoc(a.uid)).bio
  expect(bio).not.toContain('@scam_handle')
  expect(bio).not.toMatch(/555/)
  // Any text as the "📍" city label.
  expect(await restPatch(a.uid, `users/${a.uid}`, { locationLabel: '📍 1 mile away · add me @x' })).toBe(403)

  const p = await seedUser('Pia', {}, { play: { playBio: 'hi' } })
  expect(await restPatch(p.uid, `users/${p.uid}/playProfile/data`, { playBio: 'my number is 5125550123' })).toBe(200)
  await expect.poll(async () => (await db.doc(`users/${p.uid}/playProfile/data`).get()).data().playBio, { timeout: 20000 }).toContain('•••')
  const pid = await playIdOf(p.uid)
  await expect.poll(async () => (await db.doc(`playProfiles/${pid}`).get()).data()?.playBio ?? '', { timeout: 20000 }).not.toMatch(/5125550123/)
})

// ─── M3 (F-114) ──────────────────────────────────────────────────────────────

test('M3: the market follows where you are now (Austin-only launch); a brand-new account can\'t claim a founder spot', async () => {
  const far = await seedUser('Far')
  await db.doc(`userLocations/${far.uid}`).delete()
  await callAs(far.uid, 'setLocation', { lat: 41.26, lng: -95.94 }) // Omaha → linked
  const linked = (await db.doc(`userLocations/${far.uid}`).get()).data()
  expect(linked.marketCityId).toBeNull()
  expect(typeof linked.linkedCityId).toBe('string')
  // Matthew (2026-10-09): no permanent first-save lock — the deck is the
  // people where you are. Pre-launch Elite and founder claims need a Founding
  // city there (spec 46), and moves stay limited.
  await callAs(far.uid, 'setLocation', { lat: 30.25, lng: -97.75 })
  const moved = (await db.doc(`userLocations/${far.uid}`).get()).data()
  expect(moved.marketCityId).toBe('austin')
  expect(moved.linkedCityId).toBeUndefined()

  const fresh = await seedUser('Fresh')
  await daysOld(fresh.uid, 0)
  expect(await callAs(fresh.uid, 'assignFounderBadge')).toEqual({ eligible: false, reason: 'too_new' })
  await daysOld(fresh.uid, 2)
  expect((await callAs(fresh.uid, 'assignFounderBadge')).eligible).toBe(true)
})

// ─── M4 / M5 (F-115, F-116) ──────────────────────────────────────────────────

test('M5: a revoked founder keeps their old trial, gets no new one, and can\'t claim again (not even on a new account)', async () => {
  const f = await seedUser('Fay')
  await daysOld(f.uid, 3)
  const started = Timestamp.fromMillis(Date.now() - 40 * 864e5)
  const ended = Timestamp.fromMillis(Date.now() - 10 * 864e5)
  await db.doc(`userInternal/${f.uid}`).set({ trialStartedAt: started, trialEndsAt: ended, trialExpired: true }, { merge: true })
  // Claimed while Austin is founding (spots only then — Austin-only launch);
  // the city has opened by the time the spot is revoked.
  expect((await callAs(f.uid, 'assignFounderBadge')).eligible).toBe(true)
  await db.doc('config/city_austin').set({ discoveryOpenedAt: Timestamp.now(), botsActive: false }, { merge: true })
  await fnLib('founderActivity').revokeFounderStatus(f.uid)
  const plan = await internalDoc(f.uid)
  expect(plan.trialStartedAt.toMillis()).toBe(started.toMillis()) // not a fresh 30 days
  expect(plan.trialExpired).toBe(true)
  expect(await callAs(f.uid, 'assignFounderBadge')).toEqual({ eligible: false, reason: 'not_available' })
  // The number's history: a new account on the same phone can't claim either.
  const rec = (await db.doc(`founderRecords/${f.uid}`).get()).data()
  expect(typeof rec.phoneHash).toBe('string')
  expect((await db.doc(`founderHistory/${rec.phoneHash}`).get()).data().status).toBe('revoked')
})

// ─── M6 (F-117) ──────────────────────────────────────────────────────────────

test('M6: no distance after an unmatch, or to a hidden profile that isn\'t a live match', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await matchOf(a, b)
  expect((await callAs(a.uid, 'getDistances', { uids: [b.uid] })).distances[b.uid]).toBeTruthy()
  await callAs(a.uid, 'unmatchConnection', { matchId: id })
  await settle()
  expect((await callAs(a.uid, 'getDistances', { uids: [b.uid] })).distances[b.uid]).toBeUndefined()
  // Someone in the deck who hides their profile.
  const c = await woman('Cat')
  await db.doc(`exploreState/${a.uid}`).set({ spark: { deck: [c.uid] } }, { merge: true })
  expect((await callAs(a.uid, 'getDistances', { uids: [c.uid] })).distances[c.uid]).toBeTruthy()
  await db.doc(`users/${c.uid}`).update({ sparkVisibility: 'hidden' })
  expect((await callAs(a.uid, 'getDistances', { uids: [c.uid] })).distances[c.uid]).toBeUndefined()
})

// ─── M7 (F-118) ──────────────────────────────────────────────────────────────

test('M7: a free account gets no distance for a liker, and passing on one doesn\'t change the count', async () => {
  // A man (women get Elite by identity), on an expired trial: Free.
  const me = await seedUser('Fin')
  await setPlan(me.uid, 'free')
  const liker = await woman('Gia')
  await likeAs(liker.uid, me.uid)
  expect((await callAs(me.uid, 'getDistances', { uids: [liker.uid] })).distances[liker.uid]).toBeUndefined()
  const before = (await callAs(me.uid, 'getLikes', { mode: 'spark' })).count
  expect(before).toBe(1)
  await callAs(me.uid, 'recordSwipe', { targetUid: liker.uid, action: 'pass', mode: 'spark' })
  expect((await callAs(me.uid, 'getLikes', { mode: 'spark' })).count).toBe(before)
  // Paid: likers are named anyway, so the distance is there.
  await setPlan(me.uid, 'spark_plus')
  const other = await woman('Hal')
  await likeAs(other.uid, me.uid)
  expect((await callAs(me.uid, 'getDistances', { uids: [other.uid] })).distances[other.uid]).toBeTruthy()
})

// ─── M8 (F-119) ──────────────────────────────────────────────────────────────

test("M8: someone else's private dealbreaker doesn't show in your score or breakdown", async () => {
  const habits = ['reader', 'cigarette_smoker']
  const he = await seedUser('Hank', { habitTags: habits, personalityTraits: ['grounded', 'caring'], relationshipValues: ['loyalty'], loveLangGive: ['quality_time'], loveLangReceive: ['quality_time'] })
  const she = await woman('Sue', { personalityTraits: ['grounded', 'caring'], relationshipValues: ['loyalty'], loveLangGive: ['quality_time'], loveLangReceive: ['quality_time'] })
  await db.doc(`users/${she.uid}/private/matching`).set({ dealbreakers: ['cigarette_smoker'] }, { merge: true })
  await setPlan(he.uid, 'spark_plus')
  const r = await callAs(he.uid, 'onTap', { tappedUserId: she.uid })
  expect(r.breakdown.spark.dealbreakers).toBe(100)
  expect(r.triggeredDealbreakers).toEqual([])
  const pair = (await db.doc(`pairs/${sortedPair(he.uid, she.uid)}`).get()).data()
  expect(pair.sparkScoreFor[he.uid]).toBe(r.sparkScore)
  expect(pair.sparkScoreFor[she.uid]).toBeLessThanOrEqual(35)
})

// ─── M9 / M10 (F-120, F-121) ─────────────────────────────────────────────────

test('M9/M10: over its limit a number still gets allowed: true — the same answer with or without an account', async () => {
  const existing = await seedUser('Eve')
  const fresh = '+15550109876'
  for (let i = 0; i < 8; i++) {
    expect(await callAs(existing.uid, 'validatePhoneNumber', { phoneNumber: existing.phone })).toEqual({ allowed: true })
    expect(await callAs(existing.uid, 'validatePhoneNumber', { phoneNumber: fresh })).toEqual({ allowed: true })
  }
})

// ─── M11 (F-122) ─────────────────────────────────────────────────────────────

const AUTH = 'http://127.0.0.1:9409/identitytoolkit.googleapis.com/v1'
async function phoneSignUp(phone) {
  const sent = await (await fetch(`${AUTH}/accounts:sendVerificationCode?key=demo-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phoneNumber: phone, recaptchaToken: 'ignored' }),
  })).json()
  const codes = (await (await fetch(`http://127.0.0.1:9409/emulator/v1/projects/${PROJECT}/verificationCodes`)).json()).verificationCodes ?? []
  const code = codes.filter((c) => c.phoneNumber === phone).at(-1)?.code
  return (await fetch(`${AUTH}/accounts:signInWithPhoneNumber?key=demo-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionInfo: sent.sessionInfo, code }),
  })).json()
}

test('M11: a new account needs a US number (checked on the server, not just in the app)', async () => {
  const uk = await phoneSignUp('+447700900123')
  expect(JSON.stringify(uk.error ?? {})).toMatch(/US mobile number/)
  const jm = await phoneSignUp('+18765551234')
  expect(JSON.stringify(jm.error ?? {})).toMatch(/US mobile number/)
  const us = await phoneSignUp(phoneFor(77))
  expect(us.idToken).toBeTruthy()
})

// ─── M12 (F-123) ─────────────────────────────────────────────────────────────

test('M12: a sending burst pauses the sender\'s messages; the admin activity view still loads', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await matchOf(a, b)
  expect(await sendAs(a.uid, id)).toBe(200)
  // 150 in the last 10 minutes already on record.
  const now = Date.now()
  await db.doc(`rateLimits/${a.uid}`).set({ messagesBurst: Array.from({ length: 150 }, (_, i) => now - i * 1000) }, { merge: true })
  expect(await sendAs(a.uid, id)).toBe(200) // the 151st goes, and trips the pause
  await expect.poll(async () => (await internalDoc(a.uid)).messagesMutedUntil?.toMillis() ?? 0, { timeout: 20000 }).toBeGreaterThan(now)
  expect(await sendAs(a.uid, id)).toBe(403)
  expect(await sendAs(b.uid, id)).toBe(200) // only the sender is paused
  const admin = await seedUser('Kim', { isAdmin: true })
  const act = await callAs(admin.uid, 'adminGetActivity', {})
  expect(act.stats.engagement.totalMessages).toBeGreaterThanOrEqual(3)
})

// ─── M13 (F-124) ─────────────────────────────────────────────────────────────

test('M13: one account gets a few stolen-photo checks a month, not the project\'s whole budget', async () => {
  const a = await seedUser('Ann')
  const month = `rateLimits/_visionWeb_${new Date().toISOString().slice(0, 7)}`
  const photoChecks = fnLib('photoChecks')
  for (let i = 0; i < 10; i++) await photoChecks.webMatches('demo-zylove.appspot.com', `photos/${a.uid}/spark/p${i}.jpg`, a.uid)
  expect((await db.doc(month).get()).data()?.count).toBe(photoChecks.VISION_PER_ACCOUNT)
})

// ─── M14 (F-125) ─────────────────────────────────────────────────────────────

test('M14: setLocation is limited per hour (each call can reach the geocoder)', async () => {
  const a = await seedUser('Ann')
  let refused = null
  for (let i = 0; i < 12 && !refused; i++) refused = await errOf(callAs(a.uid, 'setLocation', { lat: 0.5 + i * 0.001, lng: -30 }))
  expect(refused).toMatch(/resource-exhausted|Too many|RESOURCE_EXHAUSTED/i)
})

// ─── Lows ────────────────────────────────────────────────────────────────────

test('Lows: typing docs carry only typing state; fcmTokens closed; a review needs both people to have written', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await matchOf(a, b)
  expect(await restPatch(a.uid, `matches/${id}/typing/${a.uid}`, { uid: a.uid, typingAt: 1 })).toBe(200)
  expect(await restPatch(a.uid, `matches/${id}/typing/${a.uid}`, { uid: a.uid, junk: 'x'.repeat(1000) })).toBe(403)
  expect(await restPatch(a.uid, `fcmTokens/${a.uid}`, { t: 'x' })).toBe(403)
  // Only Ann has written: no review of Bea yet.
  expect(await sendAs(a.uid, id)).toBe(200)
  await callAs(a.uid, 'unmatchConnection', { matchId: id })
  await settle()
  expect(await errOf(callAs(a.uid, 'submitReview', { matchId: id, reviewedUid: b.uid, categories: ['disrespectful'] }))).toMatch(/Have a conversation/)
})
