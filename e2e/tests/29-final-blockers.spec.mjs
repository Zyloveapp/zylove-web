// Final launch review, stage 1 blockers (2026-10): F-064/F-065 (Play IDs can't
// be tied to accounts), F-066 (18+ and the identity lock, server-side), F-067
// (no suspension escape by deleting), F-069 (unmatching keeps the evidence),
// F-070 (report limits), F-071 (blocklist context server-only), F-075 (old
// client-write rules shut), F-077 (photo-consent replay), §4.A1 (religion and
// politics owner-only), plus the data migration (scripts/lib/blockers.mjs).
import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, fnLib, PROJECT, playIdOf, playMatchOf, sortedPair, setPlan,
  Timestamp, FieldValue, internalDoc,
} from './helpers.mjs'
import { applyBlockers, planBlockers, photoHoldId } from '../../scripts/lib/blockers.mjs'

test.beforeEach(resetEmulators)

const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
async function rest(uid, path, init = {}) {
  const r = await fetch(`${BASE}/${path}`, { ...init, headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  return r.status
}
// A REST field map from plain values (strings, numbers, booleans).
const fields = (o) => ({
  fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v } : { stringValue: v }])),
})
const create = (uid, coll, id, o) => rest(uid, `${coll}?documentId=${id}`, { method: 'POST', body: JSON.stringify(fields(o)) })
const patch = (uid, path, o) => rest(uid, `${path}?${Object.keys(o).map((k) => `updateMask.fieldPaths=${k}`).join('&')}`, { method: 'PATCH', body: JSON.stringify(fields(o)) })
const errOf = (p) => p.then(() => null, (e) => String(e.message))
const PLAY = (name) => ({ playDisplayName: name, playBio: `${name}'s Play bio`, spiceLevel: 'spicy', playInterestTags: ['fwb'] })

async function seedPlayers() {
  const a = await seedUser('Adam', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ember') })
  const b = await seedUser('Bella', { genderIdentity: 'woman', attractedTo: ['men'], intent: 'open', onboardingPath: 'both' }, { play: PLAY('Velvet') })
  for (const u of [a, b]) await setPlan(u.uid, 'elite')
  return { a, b }
}
async function seedMatch(a, b, extra = {}) {
  const id = sortedPair(a.uid, b.uid)
  await db.doc(`matches/${id}`).set({
    matchId: id, users: [a.uid, b.uid].sort(), participants: [a.uid, b.uid].sort(), mode: 'spark',
    matchedAt: Timestamp.now(), createdAt: Timestamp.now(), matchGeneration: Date.now() - 1000, isBlocked: false, safetyCardShown: true,
    participantSnapshots: { [a.uid]: { displayName: a.name }, [b.uid]: { displayName: b.name } }, ...extra,
  })
  return id
}

// ─── F-065 / F-064: Play pair state, taps, distances ──────────────────────────

test('F-065: a Play tap or like never creates pairs/{uidA_uidB}; Play state is in playPairData by Play IDs; a Spark tap carries no Play score', async () => {
  const { a, b } = await seedPlayers()
  const pair = sortedPair(a.uid, b.uid)
  await likeAs(a.uid, b.uid, 'play')
  expect((await db.doc(`pairs/${pair}`).get()).exists).toBe(false)
  const key = [await playIdOf(a.uid), await playIdOf(b.uid)].sort().join('_')
  const data = (await db.doc(`playPairData/${key}`).get()).data()
  expect(data.users).toEqual([a.uid, b.uid].sort())
  expect(data.likedBy).toEqual([a.uid])
  expect(typeof data.playScore).toBe('number')
  // The Play tap answers from it; the Spark tap has no Play fields at all.
  const playTap = await callAs(a.uid, 'onTap', { tappedPlayId: await playIdOf(b.uid) })
  expect(playTap.playScore).toBe(data.playScore)
  const sparkTap = await callAs(a.uid, 'onTap', { tappedUserId: b.uid })
  expect(sparkTap.playScore).toBeUndefined()
  expect(sparkTap.breakdown.play).toBeUndefined()
  // Pairs are server-only: no read, no update (either told whether one existed).
  expect(await rest(a.uid, `pairs/${pair}`)).toBe(403)
  expect(await patch(a.uid, `pairs/${pair}`, { revealed: true })).toBe(403)
  // The Play like completes a Play match from Play state alone.
  await likeAs(b.uid, a.uid, 'play')
  expect(await playMatchOf(a.uid, b.uid)).toMatch(/^pm_/)
  expect((await db.doc(`pairs/${pair}/likes/play`).get()).exists).toBe(false)
})

test('F-065: getDistances takes one namespace per call — a uid and a Play ID together are refused', async () => {
  const { a, b } = await seedPlayers()
  const err = await errOf(callAs(a.uid, 'getDistances', { uids: [await playIdOf(b.uid), b.uid] }))
  expect(err).toMatch(/separate calls/)
  await callAs(a.uid, 'getDistances', { uids: [await playIdOf(b.uid)] })
  await callAs(a.uid, 'getDistances', { uids: [b.uid] })
})

test('F-064: a block by Play ID is a Play block — never listed (by uid) in Spark; unblocking needs the same id', async () => {
  const { a, b } = await seedPlayers()
  const bPlay = await playIdOf(b.uid)
  await callAs(a.uid, 'blockUser', { targetUid: bPlay })
  const spark = await callAs(a.uid, 'getBlockedUsers', { mode: 'spark' })
  expect(JSON.stringify(spark)).not.toContain(b.uid)
  const play = await callAs(a.uid, 'getBlockedUsers', { mode: 'play' })
  expect(play.blocked.map((x) => x.playId)).toEqual([bPlay])
  // The uid can't lift it (same answer as a stranger); the Play ID can.
  expect(await errOf(callAs(a.uid, 'unblockMember', { targetUid: b.uid }))).toMatch(/haven't blocked/)
  await callAs(a.uid, 'unblockMember', { targetUid: bPlay })
  expect((await callAs(a.uid, 'getBlockedUsers', { mode: 'play' })).blocked).toEqual([])
})

test('F-065: mixed ids in report and block get the stranger answer; a Spark match only takes a uid, a Play match a Play ID', async () => {
  const { a, b } = await seedPlayers()
  const stranger = await seedUser('Sol')
  const sparkMatch = await seedMatch(a, b)
  const bPlay = await playIdOf(b.uid)
  const asStranger = await errOf(callAs(a.uid, 'submitReport', { reportedUid: stranger.uid, matchId: sparkMatch, generation: 0, categories: ['inappropriate'] }))
  const mixed = await errOf(callAs(a.uid, 'submitReport', { reportedUid: bPlay, matchId: sparkMatch, generation: 0, categories: ['inappropriate'] }))
  expect(mixed).toMatch(/only report people you matched with/)
  expect(mixed.replace(/as e2e-[a-z]+-\d+/, '')).toBe(asStranger.replace(/as e2e-[a-z]+-\d+/, ''))
  expect(await errOf(callAs(a.uid, 'blockUser', { targetUid: bPlay, matchId: sparkMatch }))).toMatch(/Not your match/)
})

test('F-064: Curious always has a mode — called without one it is Spark, and an old Play-only reveal is not listed', async () => {
  const { a, b } = await seedPlayers()
  await db.doc(`pairs/${sortedPair(a.uid, b.uid)}`).set({ userA: [a.uid, b.uid].sort()[0], userB: [a.uid, b.uid].sort()[1], [`${b.uid}_revealed`]: true, [`${b.uid}_revealed_play`]: true, [`${b.uid}_revealedAt`]: Timestamp.now() })
  const r = await callAs(a.uid, 'getCuriousVisitors', {})
  expect(r.count).toBe(0)
})

// ─── F-066: 18+ and the identity lock ─────────────────────────────────────────

test('F-066: the rules refuse an under-18 birthday or age; the server locks identity on the first gender write and suspends anyone under 18 who got past', async () => {
  // Not locked yet (no gender written): age and birthday are still editable.
  const a = await seedUser('Una', { genderIdentity: null })
  await db.doc(`users/${a.uid}`).update({ identityLockedAt: FieldValue.delete() })
  const year = new Date().getUTCFullYear()
  expect(await patch(a.uid, `users/${a.uid}/private/identity`, { birthday: `${year - 16}-01-01` })).toBe(403)
  expect(await patch(a.uid, `users/${a.uid}/private/identity`, { birthday: `${year - 30}-01-01` })).toBe(200)
  expect(await patch(a.uid, `users/${a.uid}`, { age: 16 })).toBe(403)
  expect(await patch(a.uid, `users/${a.uid}`, { age: 31 })).toBe(200)
  // The lock: the first gender write gets it at once (server-set).
  const n = await seedUser('Nia', { genderIdentity: null })
  await db.doc(`users/${n.uid}`).update({ identityLockedAt: FieldValue.delete() })
  expect(await patch(n.uid, `users/${n.uid}`, { genderIdentity: 'woman' })).toBe(200)
  await expect.poll(async () => (await db.doc(`users/${n.uid}`).get()).get('identityLockedAt') != null, { timeout: 20000 }).toBe(true)
  // A client can't set or clear it.
  expect(await patch(n.uid, `users/${n.uid}`, { identityLockedAt: 'x' })).toBe(403)
  // Under 18 by the private birthday (got in before the rule): suspended.
  const kid = await seedUser('Kit')
  await db.doc(`users/${kid.uid}/private/identity`).set({ birthday: `${year - 15}-06-01` }, { merge: true })
  await expect.poll(async () => (await internalDoc(kid.uid))?.suspendReason ?? null, { timeout: 20000 }).toBe('underage')
  expect((await internalDoc(kid.uid)).isSuspended).toBe(true)
  expect((await db.doc(`trustFlags/${kid.uid}`).get()).data()).toMatchObject({ status: 'open', reasons: [expect.objectContaining({ key: 'underage' })] })
})

test('F-066: identity-based Elite needs the lock', async () => {
  const w = await seedUser('Wren', { genderIdentity: 'woman', attractedTo: ['men'] })
  const ent = fnLib('entitlements')
  const root = (await db.doc(`users/${w.uid}`).get()).data()
  expect(ent.computeEntitlement({ root, plan: {}, matching: {} }).source).toBe('identity')
  expect(ent.computeEntitlement({ root: { ...root, identityLockedAt: null }, plan: {}, matching: {} }).source).not.toBe('identity')
})

// ─── F-067: suspension escape ─────────────────────────────────────────────────

test('F-067: an account deleted while suspended brings the suspension to a new account on the same number; restore is refused while suspended', async () => {
  const s = await seedUser('Sam')
  await fnLib('reports').suspendAccount(s.uid, null, 'admin-e2e', 'admin')
  const record = await fnLib('userData').recoveryRecord(s.uid, (await db.doc(`users/${s.uid}`).get()).data(), s.phone)
  expect(record.suspension).toMatchObject({ suspendedPendingReview: true })
  expect(record.genderIdentity).toBe('man')
  // (Timestamps rebuilt with this process's SDK; the record is otherwise as written.)
  const ts = (v) => (v && typeof v.toMillis === 'function' ? Timestamp.fromMillis(v.toMillis()) : v)
  await db.doc(`deletedAccounts/${s.phone}`).set({
    ...record, deletedAt: Timestamp.now(), identityLockedAt: ts(record.identityLockedAt),
    suspension: { ...record.suspension, suspendedAt: ts(record.suspension.suspendedAt), suspendedUntil: ts(record.suspension.suspendedUntil) },
  })
  // The new account on that number is refused at sign-in, with the appeal path.
  await fnLib('trust').carrySuspension('e2e-sam-new', s.phone)
  expect((await internalDoc('e2e-sam-new'))).toMatchObject({ isSuspended: true, carriedFrom: s.uid })
  expect(await fnLib('appeals').suspensionRefusal('e2e-sam-new')).toMatch(/^ZYLOVE_SUSPENDED:/)
  // Its trust links stayed (device sightings, trust profile).
  expect((await fnLib('userData').moderationCarry(s.uid)).keepTrustLinks).toBe(true)
})

test('F-067: restoreAccount is refused for a caller who is suspended or already has a profile', async () => {
  const old = await seedUser('Olly')
  const now = await seedUser('Nova')
  const rec = await fnLib('userData').recoveryRecord(old.uid, (await db.doc(`users/${old.uid}`).get()).data(), now.phone)
  await db.doc(`deletedAccounts/${now.phone}`).set({ ...rec, deletedAt: Timestamp.now(), identityLockedAt: Timestamp.now() })
  expect(await errOf(callAs(now.uid, 'restoreAccount'))).toMatch(/can't be restored from here/)
})

// ─── F-069: evidence on unmatch ───────────────────────────────────────────────

test('F-069: the person blocked can\'t delete the chat; an unmatch keeps it read-only for the other person, who can then remove it', async () => {
  const a = await seedUser('Ann')
  const b = await seedUser('Ben')
  const blocked = await seedMatch(a, b, { isBlocked: true, blockedBy: a.uid })
  await db.doc(`matches/${blocked}/messages/m1`).set({ senderId: b.uid, ciphertext: 'x', nonce: 'n', sentAt: Timestamp.now(), messageType: 'text', status: 'sent' })
  await callAs(b.uid, 'unmatchConnection', { matchId: blocked })
  expect((await db.doc(`matches/${blocked}`).get()).exists).toBe(true)
  expect((await db.doc(`matches/${blocked}/messages/m1`).get()).exists).toBe(true)

  const c = await seedUser('Cal')
  const d = await seedUser('Dee')
  const id = await seedMatch(c, d)
  await callAs(c.uid, 'unmatchConnection', { matchId: id })
  const kept = (await db.doc(`matches/${id}`).get()).data()
  expect(kept).toMatchObject({ users: [d.uid], preservedFor: [d.uid], unmatchedBy: c.uid })
  expect(await rest(c.uid, `matches/${id}`)).toBe(403)
  expect(await rest(d.uid, `matches/${id}`)).toBe(200)
  // The one who left can't act on it any more; the one kept can remove it.
  expect(await errOf(callAs(c.uid, 'unmatchConnection', { matchId: id }))).toMatch(/Not a participant/)
  await callAs(d.uid, 'unmatchConnection', { matchId: id })
  await expect.poll(async () => (await db.doc(`matches/${id}`).get()).exists, { timeout: 15000 }).toBe(false)
})

// ─── F-070: reports ───────────────────────────────────────────────────────────

test('F-070: the server sets the report\'s generation, and a reporter gets 10 reports a day', async () => {
  const r = await seedUser('Rae')
  const id = await seedMatch(r, await seedUser('Tom'))
  const gen = (await db.doc(`matches/${id}`).get()).get('matchGeneration')
  const tom = (await db.doc(`matches/${id}`).get()).get('users').find((u) => u !== r.uid)
  await callAs(r.uid, 'submitReport', { reportedUid: tom, matchId: id, generation: 12345, categories: ['inappropriate'] })
  expect((await db.doc(`reports/${r.uid}_${tom}_${gen}`).get()).exists).toBe(true)
  expect((await db.doc(`reports/${r.uid}_${tom}_12345`).get()).exists).toBe(false)
  for (let i = 0; i < 9; i++) await callAs(r.uid, 'submitReport', { reportedUid: tom, matchId: id, generation: gen, categories: ['inappropriate'] })
  expect(await errOf(callAs(r.uid, 'submitReport', { reportedUid: tom, matchId: id, generation: gen, categories: ['inappropriate'] }))).toMatch(/a lot of reports today/)
})

// ─── F-071, F-075, F-077, §4.A1 ───────────────────────────────────────────────

test('F-071: a blocklist hold\'s context is server-only; Photo review still shows it', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const u = await seedUser('Uma')
  const url = `photos/${u.uid}/spark/held.jpg`
  await db.doc(`users/${u.uid}/private/account`).set({ pendingPhotoURLs: [{ url, mode: 'spark', flaggedAt: Timestamp.now(), reason: { blocklist: true }, approved: false }] }, { merge: true })
  await db.doc(`userInternal/${u.uid}`).set({ hasPendingPhotos: true }, { merge: true })
  await db.doc(`photoHolds/${photoHoldId(u.uid, url)}`).set({ uid: u.uid, url, match: { uid: 'banned-1', name: 'Scammer', bannedAt: 1, adminMarkedScam: true, reports: { scam: 2 }, distance: 0 }, more: 0, distance: 0 })
  expect(await rest(u.uid, `photoHolds/${photoHoldId(u.uid, url)}`)).toBe(403)
  const { photos } = await callAs(admin.uid, 'listPendingPhotos')
  expect(photos.find((p) => p.url === url)?.blocklistMatch).toMatchObject({ uid: 'banned-1', name: 'Scammer' })
})

test('F-075: old collections take no client writes; sparkProfile is the owner\'s only, data only, known fields only', async () => {
  const a = await seedUser('Al')
  const b = await seedUser('Bo')
  expect(await create(a.uid, 'reviewQueue', 'x1', { reporterUid: a.uid, reportedUid: b.uid, reason: 'review_felt_unsafe' })).toBe(403)
  expect(await create(a.uid, 'swipes', 'x2', { swiperId: a.uid, target: b.uid })).toBe(403)
  expect(await create(a.uid, 'scoreEvents', 'x3', { uid: b.uid, reason: 'unmatch_x' })).toBe(403)
  expect(await create(a.uid, 'unmatchReasons', 'x4', { reporterUid: a.uid })).toBe(403)
  expect(await create(a.uid, 'notifications', 'x5', { uid: b.uid, title: 'hi' })).toBe(403)
  expect(await rest(a.uid, `users/${b.uid}/sparkProfile/data`)).toBe(403)
  expect(await patch(a.uid, `users/${a.uid}/sparkProfile/data`, { bio: 'ok' })).toBe(200)
  expect(await patch(a.uid, `users/${a.uid}/sparkProfile/data`, { anything: 'no' })).toBe(403)
  expect(await create(a.uid, `users/${a.uid}/sparkProfile`, 'other', { bio: 'no' })).toBe(403)
  // A client-made review flag (made here by the server SDK) doesn't count.
  await db.doc('reviewQueue/forged').set({ reportedUid: b.uid, reason: 'review_felt_unsafe' })
  expect(await fnLib('trustScore').reviewFlagsOf(b.uid)).toEqual([])
})

test('F-077: a pending photo consent can only name its sender; a request from before a pause can\'t be accepted again', async () => {
  const a = await seedUser('Ari')
  const b = await seedUser('Bex')
  const id = await seedMatch(a, b)
  // b asked once, a accepted; then b paused.
  const msg = (sender, code) => db.collection(`matches/${id}/messages`).add({ senderId: sender, messageType: 'consent_request', ciphertext: code, nonce: 'system', sentAt: Timestamp.fromMillis(Date.now() - (code === 'photo_consent_request' ? 60000 : 1000)), status: 'sent' })
  await msg(b.uid, 'photo_consent_request')
  await msg(b.uid, 'photo_consent_paused')
  await db.doc(`matches/${id}`).update({ photoConsent: { status: 'paused', requestedBy: b.uid } })
  // a can't re-mark it pending "from" b …
  expect(await rest(a.uid, `matches/${id}?updateMask.fieldPaths=photoConsent`, { method: 'PATCH', body: JSON.stringify({ fields: { photoConsent: { mapValue: { fields: { status: { stringValue: 'pending' }, requestedBy: { stringValue: b.uid } } } } } }) })).toBe(403)
  // … and even if it were pending, the latest consent message is the pause.
  await db.doc(`matches/${id}`).update({ photoConsent: { status: 'pending', requestedBy: b.uid } })
  expect(await errOf(callAs(a.uid, 'acceptPhotoConsent', { matchId: id }))).toMatch(/No matching photo request/)
})

test('§4.A1: religion and politics are refused on the public doc, kept in private/matching, and never on a deck card; a hidden gender is off the card too', async () => {
  const a = await seedUser('Ivy')
  expect(await patch(a.uid, `users/${a.uid}`, { religion: 'catholic' })).toBe(403)
  expect(await patch(a.uid, `users/${a.uid}/private/matching`, { religion: 'catholic', politicalView: 'moderate' })).toBe(200)
  const card = fnLib('explore').sparkCardProfile({ displayName: 'X', religion: 'jewish', politicalView: 'liberal', genderIdentity: 'trans_woman', genderSelfDescribe: 'x', genderHidden: true })
  expect(card).toEqual({ displayName: 'X', genderHidden: true })
  expect(fnLib('explore').sparkCardProfile({ genderIdentity: 'non_binary' })).toEqual({ genderIdentity: 'non_binary' })
})

// ─── Migration ────────────────────────────────────────────────────────────────

test('migration: Play pair docs move to playPairData; uid-pair Play past connections go; religion moves to private/matching; hold context moves; idempotent', async () => {
  const { a, b } = await seedPlayers()
  const pair = sortedPair(a.uid, b.uid)
  await db.doc(`pairs/${pair}`).set({ userA: [a.uid, b.uid].sort()[0], userB: [a.uid, b.uid].sort()[1] })
  await db.doc(`pairs/${pair}/likes/play`).set({ likedBy: [a.uid] })
  await db.doc(`pairs/${pair}/modes/play`).set({ playScore: 77, playBreakdown: { x: 1 } })
  await db.doc(`pastConnections/${pair}_1`).set({ matchId: pair, generation: 1, users: [a.uid, b.uid], mode: 'play', matchedAt: Timestamp.now() })
  await db.doc(`users/${a.uid}`).update({ religion: 'buddhist', politicalView: 'liberal' })
  const url = `photos/${b.uid}/spark/h.jpg`
  await db.doc(`users/${b.uid}/private/account`).set({ pendingPhotoURLs: [{ url, reason: { blocklist: true, distance: 1, match: { uid: 'z', name: 'Z' }, more: 0 } }] }, { merge: true })

  const plan = await planBlockers({ db })
  expect(plan.playPairs).toHaveLength(1)
  expect(plan.legacyPast).toHaveLength(1)
  expect(plan.beliefs.map((x) => x.uid)).toEqual([a.uid])
  expect(plan.holds).toHaveLength(1)
  expect(Object.keys(plan.backup)).toEqual(expect.arrayContaining([`pairs/${pair}/likes/play`, `pastConnections/${pair}_1`, `users/${a.uid}`]))
  await applyBlockers({ db, FieldValue, Timestamp }, plan)

  const key = [await playIdOf(a.uid), await playIdOf(b.uid)].sort().join('_')
  expect((await db.doc(`playPairData/${key}`).get()).data()).toMatchObject({ likedBy: [a.uid], playScore: 77, users: [a.uid, b.uid].sort() })
  expect((await db.doc(`pairs/${pair}/likes/play`).get()).exists).toBe(false)
  expect((await db.doc(`pairs/${pair}/modes/play`).get()).exists).toBe(false)
  expect((await db.doc(`pastConnections/${pair}_1`).get()).exists).toBe(false)
  expect((await db.doc(`users/${a.uid}`).get()).get('religion')).toBeUndefined()
  expect((await db.doc(`users/${a.uid}/private/matching`).get()).data()).toMatchObject({ religion: 'buddhist', politicalView: 'liberal' })
  expect((await db.doc(`users/${b.uid}/private/account`).get()).get('pendingPhotoURLs')[0].reason).toEqual({ blocklist: true })
  expect((await db.doc(`photoHolds/${photoHoldId(b.uid, url)}`).get()).data()).toMatchObject({ match: { uid: 'z' } })

  const again = await planBlockers({ db })
  expect([again.playPairs.length, again.legacyPast.length, again.beliefs.length, again.holds.length]).toEqual([0, 0, 0, 0])
})
