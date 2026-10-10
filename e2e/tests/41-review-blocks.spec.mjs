// Fresh-eyes review (2026-10-09), blocks: C1 (the person blocked took the
// block over — re-block, unblock, unmatch — in Spark and Play), H3 (a block
// you place in one mode changes nothing you're shown in the other; one
// placed on you holds in both) and H5 (whoever blocks first, the other
// person keeps the chat read-only for the 30-day report window, with the
// key to read it and evidence to attach).
import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, PROJECT, playIdOf, playMatchOf, sortedPair, setPlan, Timestamp,
  signIn, offline, quietFirstRun, CONTEXT, userDoc, FieldValue,
} from './helpers.mjs'
import { applyBlocks, planBlocks, summaryBlocks } from '../../scripts/lib/blocks.mjs'

test.beforeEach(resetEmulators)

const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
const restGet = async (uid, path) => (await fetch(`${BASE}/${path}`, { headers: { Authorization: `Bearer ${await idTokenFor(uid)}` } })).status
const errOf = (p) => p.then(() => null, (e) => String(e.message))
const PLAY = (name) => ({ playDisplayName: name, playBio: `${name}'s Play bio`, spiceLevel: 'spicy', playInterestTags: ['fwb'] })
const woman = (name, o = {}, opts) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o }, opts)

async function players() {
  const a = await seedUser('Adam', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ember') })
  const v = await woman('Vera', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Velvet') })
  for (const u of [a, v]) await setPlan(u.uid, 'elite')
  return { a, v }
}
async function sparkMatch(a, b) {
  await likeAs(a.uid, b.uid)
  expect((await likeAs(b.uid, a.uid)).matched).toBe(true)
  return sortedPair(a.uid, b.uid)
}
async function playMatch(a, b) {
  await likeAs(a.uid, b.uid, 'play')
  await likeAs(b.uid, a.uid, 'play')
  const id = await playMatchOf(a.uid, b.uid)
  expect(id).toMatch(/^pm_/)
  return id
}
const col = (matchId) => (matchId.startsWith('pm_') ? 'playMatches' : 'matches')
const say = (matchId, senderId, text) =>
  db.collection(`${col(matchId)}/${matchId}/messages`).add({ senderId, messageType: 'text', ciphertext: text, nonce: 'n', status: 'sent', sentAt: new Date() })
const mirrors = async (x, y) => [(await db.doc(`users/${x}/blockedUsers/${y}`).get()).data(), (await db.doc(`users/${y}/blockedUsers/${x}`).get()).data()]

// ─── C1: the person blocked can't take the block over ─────────────────────────
// Soft checks: every step of the attack is reported, not just the first.

test('C1 Spark: the person blocked re-blocks (no-op), can\'t unblock, can\'t unmatch — the victim keeps the block, the chat and its messages', async () => {
  const { a, v } = await players()
  const id = await sparkMatch(a, v)
  const msg = await say(id, a.uid, 'abuse')
  // 1. Vera blocks Adam from the chat.
  await callAs(v.uid, 'blockUser', { targetUid: a.uid, matchId: id })
  const before = (await db.doc(`matches/${id}`).get()).data()
  expect.soft(before).toMatchObject({ isBlocked: true, blockedBy: v.uid })

  // 2. Adam blocks her back — with the match and without it: success, nothing changes.
  await callAs(a.uid, 'blockUser', { targetUid: v.uid, matchId: id })
  await callAs(a.uid, 'blockUser', { targetUid: v.uid })
  for (const rec of await mirrors(a.uid, v.uid)) expect.soft(rec).toMatchObject({ blockedBy: v.uid })
  const after = (await db.doc(`matches/${id}`).get()).data()
  expect.soft(after).toMatchObject({ isBlocked: true, blockedBy: v.uid })
  expect.soft(after.blockedAt.toMillis()).toBe(before.blockedAt.toMillis())
  // Still hers to see in her list; never in his.
  expect.soft((await callAs(v.uid, 'getBlockedUsers', { mode: 'spark' })).blocked.map((b) => b.uid)).toEqual([a.uid])
  expect.soft((await callAs(a.uid, 'getBlockedUsers', { mode: 'spark' })).blocked).toEqual([])
  // Her chat is still hers: the match, its messages; her profile still closed to him.
  expect.soft(await restGet(v.uid, `matches/${id}`)).toBe(200)
  expect.soft(await restGet(v.uid, `matches/${id}/messages/${msg.id}`)).toBe(200)
  expect.soft(await restGet(a.uid, `users/${v.uid}`)).toBe(403)

  // 3. He can't lift it (mobile's unblockUser or the web's unblockMember).
  expect.soft(await errOf(callAs(a.uid, 'unblockUser', { targetUid: v.uid }))).toMatch(/haven't blocked/)
  expect.soft(await errOf(callAs(a.uid, 'unblockMember', { targetUid: v.uid }))).toMatch(/haven't blocked/)
  for (const rec of await mirrors(a.uid, v.uid)) expect.soft(rec).toMatchObject({ blockedBy: v.uid })
  await expect.soft(callAs(a.uid, 'onTap', { tappedUserId: v.uid })).rejects.toThrow(/isn't available/)

  // 4. He can't end the chat she blocked: unmatch is a quiet no-op.
  await callAs(a.uid, 'unmatchConnection', { matchId: id })
  const kept = (await db.doc(`matches/${id}`).get()).data()
  expect.soft(kept).toMatchObject({ isBlocked: true, blockedBy: v.uid, users: [a.uid, v.uid].sort() })
  expect.soft(kept.unmatchedAt ?? null).toBeNull()
  expect.soft((await db.doc(`matches/${id}/messages/${msg.id}`).get()).exists).toBe(true)
  expect.soft(await restGet(v.uid, `matches/${id}/messages/${msg.id}`)).toBe(200)
})

test('C1 Play: the same through blockUser and actOnPlayConnection — the block stays hers, by Play ID', async () => {
  const { a, v } = await players()
  const id = await playMatch(a, v)
  const [aPlay, vPlay] = [await playIdOf(a.uid), await playIdOf(v.uid)]
  const msg = await say(id, aPlay, 'abuse')
  await callAs(v.uid, 'blockUser', { targetUid: aPlay, matchId: id })
  expect.soft((await db.doc(`playMatches/${id}`).get()).data()).toMatchObject({ isBlocked: true, blockedBy: vPlay })

  await callAs(a.uid, 'blockUser', { targetUid: vPlay, matchId: id })
  await callAs(a.uid, 'blockUser', { targetUid: vPlay })
  await callAs(a.uid, 'actOnPlayConnection', { matchId: id, action: 'block' })
  for (const rec of await mirrors(a.uid, v.uid)) expect.soft(rec).toMatchObject({ blockedBy: v.uid, mode: 'play' })
  expect.soft((await db.doc(`playMatches/${id}`).get()).data()).toMatchObject({ isBlocked: true, blockedBy: vPlay })
  expect.soft((await callAs(v.uid, 'getBlockedUsers', { mode: 'play' })).blocked.map((b) => b.playId)).toEqual([aPlay])
  expect.soft((await callAs(a.uid, 'getBlockedUsers', { mode: 'play' })).blocked).toEqual([])

  expect.soft(await errOf(callAs(a.uid, 'unblockUser', { targetUid: vPlay }))).toMatch(/haven't blocked/)
  expect.soft(await errOf(callAs(a.uid, 'unblockMember', { targetUid: vPlay }))).toMatch(/haven't blocked/)
  for (const rec of await mirrors(a.uid, v.uid)) expect.soft(rec).toMatchObject({ blockedBy: v.uid })
  expect.soft(await restGet(a.uid, `playProfiles/${vPlay}`)).toBe(403)

  await callAs(a.uid, 'unmatchConnection', { matchId: id })
  const kept = (await db.doc(`playMatches/${id}`).get()).data()
  expect.soft(kept).toMatchObject({ isBlocked: true, blockedBy: vPlay, players: [aPlay, vPlay].sort() })
  expect.soft(kept.unmatchedAt ?? null).toBeNull()
  expect.soft(await restGet(v.uid, `playMatches/${id}`)).toBe(200)
  expect.soft(await restGet(v.uid, `playMatches/${id}/messages/${msg.id}`)).toBe(200)
})

// ─── H3: a block you place in one mode says nothing about the other ──────────

const BUCKET = 'demo-zylove.appspot.com'
async function publishPhotos(u) {
  const { getStorage } = await import('firebase-admin/storage')
  const uPlay = await playIdOf(u.uid)
  const spark = `photos/${u.uid}/spark/s.png`
  const play = `playPhotos/${uPlay}/p.png`
  for (const ref of [spark, play]) await getStorage().bucket(BUCKET).file(ref).save(Buffer.from('89504e47', 'hex'), { contentType: 'image/png', metadata: { metadata: { zyloveCopy: '1' } } })
  await db.doc(`users/${u.uid}`).update({ photoURLs: [spark] })
  await db.doc(`users/${u.uid}/playProfile/data`).update({ photoURLs: [play] })
  return { spark, play }
}
// Everything `x` can ask about `u` in `mode` (u named as that mode names them).
async function probes(x, u, mode, photo) {
  const id = mode === 'play' ? await playIdOf(u.uid) : u.uid
  const ok = (p) => p.then(() => 'ok', (e) => (/isn't available/.test(String(e.message)) ? 'unavailable' : String(e.message)))
  const deck = await callAs(x.uid, 'getExploreDeck', { mode })
  return {
    tap: await ok(callAs(x.uid, 'onTap', mode === 'play' ? { tappedPlayId: id } : { tappedUserId: id })),
    swipe: await ok(callAs(x.uid, 'recordSwipe', { mode, targetUid: id, action: 'maybe' })),
    photo: Object.keys((await callAs(x.uid, 'getPhotoUrls', { refs: [photo] })).urls).length === 1,
    deck: deck.cards.some((c) => (mode === 'play' ? c.playId : c.uid) === id),
    distance: id in (await callAs(x.uid, 'getDistances', { uids: [id] })).distances,
  }
}
const OPEN = { tap: 'ok', swipe: 'ok', photo: true, deck: true, distance: true }
const SHUT = { tap: 'unavailable', swipe: 'unavailable', photo: false, deck: false, distance: false }

async function h3Players() {
  const x = await seedUser('Xan', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Onyx') })
  const u = await woman('Uma', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Umbra') })
  for (const p of [x, u]) await setPlan(p.uid, 'elite')
  return { x, u, photos: await publishPhotos(u) }
}

test('H3: blocking a uid leaves every Play answer about their Play ID unchanged (tap, swipe, photos, deck, distance, likes, Sent)', async () => {
  const { x, u, photos } = await h3Players()
  const uPlay = await playIdOf(u.uid)
  expect(await probes(x, u, 'play', photos.play)).toEqual(OPEN)
  // A Play like before the block (it takes her out of his Play deck, as
  // any like does) stays in his Sent list.
  await likeAs(x.uid, u.uid, 'play')
  const sentBefore = (await callAs(x.uid, 'getSentSparks', { mode: 'play' })).sent.map((s) => s.playId)
  expect(sentBefore).toEqual([uPlay])
  const playBefore = await probes(x, u, 'play', photos.play)
  // F-117: liked, so out of the deck — and no longer a distance either (only
  // the current deck, live matches and likers who liked you get one).
  expect(playBefore).toEqual({ ...OPEN, deck: false, distance: false })

  await callAs(x.uid, 'blockUser', { targetUid: u.uid })
  expect((await mirrors(x.uid, u.uid))[0]).toMatchObject({ blockedBy: x.uid, mode: 'spark', modes: ['spark'] })
  // Spark: blocked, as asked.
  expect(await probes(x, u, 'spark', photos.spark)).toEqual(SHUT)
  // Play: exactly as before.
  expect(await probes(x, u, 'play', photos.play)).toEqual(playBefore)
  expect((await callAs(x.uid, 'getSentSparks', { mode: 'play' })).sent.map((s) => s.playId)).toEqual(sentBefore)
  expect(await restGet(x.uid, `playProfiles/${uPlay}`)).toBe(200)
  // A Play like gets the usual answer — but reaches nobody: the person
  // blocked never hears from him.
  expect(await likeAs(x.uid, u.uid, 'play')).toMatchObject({ matched: false })
  expect((await callAs(u.uid, 'getLikeCount', { mode: 'play' })).count).toBe(0)
  // Unblocking by uid lifts the Spark block only (there's nothing else).
  await callAs(x.uid, 'unblockMember', { targetUid: u.uid })
  expect(await probes(x, u, 'spark', photos.spark)).toMatchObject({ tap: 'ok', swipe: 'ok', photo: true })
})

test('H3: blocking a Play ID leaves every Spark answer about the uid unchanged; blocked in both, lifting one leaves the other', async () => {
  const { x, u, photos } = await h3Players()
  const uPlay = await playIdOf(u.uid)
  expect(await probes(x, u, 'spark', photos.spark)).toEqual(OPEN)
  await callAs(x.uid, 'blockUser', { targetUid: uPlay })
  expect(await probes(x, u, 'play', photos.play)).toEqual(SHUT)
  expect(await probes(x, u, 'spark', photos.spark)).toEqual(OPEN)
  expect(await restGet(x.uid, `users/${u.uid}`)).toBe(200)

  // Now the uid too: one record, both modes; each id lifts its own.
  await callAs(x.uid, 'blockUser', { targetUid: u.uid })
  for (const rec of await mirrors(x.uid, u.uid)) expect([...rec.modes].sort()).toEqual(['play', 'spark'])
  expect(await probes(x, u, 'spark', photos.spark)).toEqual(SHUT)
  expect((await callAs(x.uid, 'getBlockedUsers', { mode: 'spark' })).blocked.map((b) => b.uid)).toEqual([u.uid])
  expect((await callAs(x.uid, 'getBlockedUsers', { mode: 'play' })).blocked.map((b) => b.playId)).toEqual([uPlay])
  await callAs(x.uid, 'unblockMember', { targetUid: uPlay })
  expect(await probes(x, u, 'play', photos.play)).toMatchObject({ tap: 'ok', swipe: 'ok', photo: true })
  expect(await probes(x, u, 'spark', photos.spark)).toEqual(SHUT)
  for (const rec of await mirrors(x.uid, u.uid)) expect(rec).toMatchObject({ blockedBy: x.uid, modes: ['spark'] })
  await callAs(x.uid, 'unblockMember', { targetUid: u.uid })
  expect((await mirrors(x.uid, u.uid)).every((r) => r === undefined)).toBe(true)
  expect(await probes(x, u, 'spark', photos.spark)).toMatchObject({ tap: 'ok', swipe: 'ok', photo: true })
})

test('H3: a block placed ON you holds in both modes (the person who blocked you stays out of reach); they still see you where they didn\'t block', async () => {
  const { x, u, photos } = await h3Players()
  const xPhotos = await publishPhotos(x)
  // Uma blocks Xan in Spark. To him she's unavailable in Spark and in Play —
  // her safety over hiding which Play ID is hers from him (the accepted,
  // one-off residual: only she can create it).
  await callAs(u.uid, 'blockUser', { targetUid: x.uid })
  expect(await probes(x, u, 'spark', photos.spark)).toEqual(SHUT)
  expect(await probes(x, u, 'play', photos.play)).toEqual(SHUT)
  expect(await restGet(x.uid, `playProfiles/${await playIdOf(u.uid)}`)).toBe(403)
  await expect(likeAs(x.uid, u.uid, 'play')).rejects.toThrow(/isn't available/)
  // Her own Play view of him is unchanged by her Spark block.
  expect(await probes(u, x, 'play', xPhotos.play)).toMatchObject({ tap: 'ok', swipe: 'ok', photo: true })
  // He can't block her back over it — and that doesn't list her as his block.
  await callAs(x.uid, 'blockUser', { targetUid: await playIdOf(u.uid) })
  expect((await callAs(x.uid, 'getBlockedUsers', { mode: 'play' })).blocked).toEqual([])
})

// ─── H5: whoever blocks first, the other keeps the chat read-only ────────────

const STORAGE = `http://127.0.0.1:9909/v0/b/${BUCKET}/o`
async function upload(uid, path) {
  const boundary = 'b' + Math.random().toString(36).slice(2)
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ name: path, contentType: 'image/x-zylove-encrypted' })}\r\n--${boundary}\r\nContent-Type: image/x-zylove-encrypted\r\n\r\n`),
    Buffer.from('sealed'),
    Buffer.from(`\r\n--${boundary}--`),
  ])
  return (await fetch(`${STORAGE}?name=${encodeURIComponent(path)}`, {
    method: 'POST', headers: { Authorization: `Firebase ${await idTokenFor(uid)}`, 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).status
}
const readPhoto = async (uid, path) => (await fetch(`${STORAGE}/${encodeURIComponent(path)}?alt=media`, { headers: { Authorization: `Firebase ${await idTokenFor(uid)}` } })).status
const restFields = (o) => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '__now__' ? { timestampValue: new Date().toISOString() } : { stringValue: v }])) })
async function restCreate(uid, path, o) {
  return (await fetch(`${BASE}/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(restFields(o)) })).status
}
async function restPatch(uid, path, o) {
  const mask = Object.keys(o).map((k) => `updateMask.fieldPaths=${k}`).join('&')
  return (await fetch(`${BASE}/${path}?${mask}`, { method: 'PATCH', headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(restFields(o)) })).status
}
const KEY = (c) => c.repeat(43) + '='
const DAY = 864e5

test('H5 Spark: he blocks first — she still reads the chat and its photos (read-only, with his key), reports with evidence; he can\'t take it by unmatching', async () => {
  const { a, v } = await players()
  const id = await sparkMatch(a, v)
  await db.doc(`users/${a.uid}`).update({ publicKey: KEY('A') })
  await db.doc(`users/${v.uid}`).update({ publicKey: KEY('V') })
  await db.doc(`matches/${id}`).update({ photoConsent: { status: 'accepted', requestedBy: v.uid } })
  const photo = `chat-photos/${id}/${a.uid}_1.bin`
  expect(await upload(a.uid, photo)).toBe(200)
  const msg = await say(id, a.uid, 'sealed-abuse')

  await callAs(a.uid, 'blockUser', { targetUid: v.uid, matchId: id })
  const m = (await db.doc(`matches/${id}`).get()).data()
  expect(m).toMatchObject({ isBlocked: true, blockedBy: a.uid, preservedFor: [a.uid, v.uid].sort(), preservedForReport: false, chatKeys: { [a.uid]: KEY('A'), [v.uid]: KEY('V') } })
  expect(m.preservedUntil.toMillis()).toBeGreaterThan(Date.now() + 29 * DAY)
  expect(m.preservedUntil.toMillis()).toBeLessThan(Date.now() + 31 * DAY)

  // Vera, the one blocked: reads the match, the message and his photo…
  expect(await restGet(v.uid, `matches/${id}`)).toBe(200)
  expect(await restGet(v.uid, `matches/${id}/messages/${msg.id}`)).toBe(200)
  expect(await readPhoto(v.uid, photo)).toBe(200)
  // …but sends nothing, types nothing, changes nothing; his profile stays closed.
  expect(await restCreate(v.uid, `matches/${id}/messages`, { senderId: v.uid, messageType: 'text', ciphertext: 'x', nonce: 'n', status: 'sent', sentAt: '__now__' })).toBe(403)
  expect(await restCreate(v.uid, `matches/${id}/typing?documentId=${v.uid}`, { at: 'x' })).toBe(403)
  expect(await restPatch(v.uid, `matches/${id}`, { lastMessagePreview: 'hi' })).toBe(403)
  expect(await upload(v.uid, `chat-photos/${id}/${v.uid}_2.bin`)).toBe(403)
  expect(await restGet(v.uid, `users/${a.uid}`)).toBe(403)
  // He keeps it too, read-only.
  expect(await restGet(a.uid, `matches/${id}/messages/${msg.id}`)).toBe(200)
  expect(await restCreate(a.uid, `matches/${id}/messages`, { senderId: a.uid, messageType: 'text', ciphertext: 'x', nonce: 'n', status: 'sent', sentAt: '__now__' })).toBe(403)

  // She reports him and attaches the message.
  await callAs(v.uid, 'submitReport', { matchId: id, reportedUid: a.uid, categories: ['felt_unsafe'] })
  const ev = await callAs(v.uid, 'submitEvidence', { matchId: id, reportedUid: a.uid, items: [{ msgId: msg.id, plaintext: 'abuse', kf: null }] })
  expect(ev.summary).toMatchObject({ items: 1 })

  // He unmatches: the chat stays — for her (she reported), not him.
  await callAs(a.uid, 'unmatchConnection', { matchId: id })
  expect((await db.doc(`matches/${id}`).get()).data()).toMatchObject({ users: [v.uid], preservedFor: [v.uid], isBlocked: true })
  expect(await restGet(v.uid, `matches/${id}/messages/${msg.id}`)).toBe(200)
  expect(await restGet(a.uid, `matches/${id}`)).toBe(403)
})

test('H5 Play: the same by Play ID — she reads it, can\'t write, reports with evidence', async () => {
  const { a, v } = await players()
  const id = await playMatch(a, v)
  const [aPlay, vPlay] = [await playIdOf(a.uid), await playIdOf(v.uid)]
  await db.doc(`playProfiles/${aPlay}`).update({ publicPlayKey: KEY('P') })
  const msg = await say(id, aPlay, 'sealed-abuse')
  await callAs(a.uid, 'blockUser', { targetUid: vPlay, matchId: id })
  const m = (await db.doc(`playMatches/${id}`).get()).data()
  expect(m).toMatchObject({ isBlocked: true, blockedBy: aPlay, preservedFor: [aPlay, vPlay].sort(), chatKeys: { [aPlay]: KEY('P') } })
  expect(JSON.stringify(m)).not.toContain(a.uid)
  expect(await restGet(v.uid, `playMatches/${id}`)).toBe(200)
  expect(await restGet(v.uid, `playMatches/${id}/messages/${msg.id}`)).toBe(200)
  expect(await restCreate(v.uid, `playMatches/${id}/messages`, { senderId: vPlay, messageType: 'text', ciphertext: 'x', nonce: 'n', status: 'sent', sentAt: '__now__' })).toBe(403)
  expect(await restGet(v.uid, `playProfiles/${aPlay}`)).toBe(403)
  await callAs(v.uid, 'submitReport', { matchId: id, reportedUid: aPlay, categories: ['felt_unsafe'] })
  const ev = await callAs(v.uid, 'submitEvidence', { matchId: id, reportedUid: aPlay, items: [{ msgId: msg.id, plaintext: 'abuse', kf: null }] })
  expect(ev.summary).toMatchObject({ items: 1 })
  // Unmatching it isn't hers to do (he blocked it).
  await callAs(v.uid, 'unmatchConnection', { matchId: id })
  expect((await db.doc(`playMatches/${id}`).get()).data()).toMatchObject({ isBlocked: true, players: [aPlay, vPlay].sort() })
})

test('H5: after 30 days a blocked chat is the blocker\'s alone again; one that was also unmatched is deleted, as before', async () => {
  const { a, v } = await players()
  const c = await woman('Cleo')
  const id = await sparkMatch(a, v)
  const other = await sparkMatch(a, c)
  const msg = await say(id, a.uid, 'x')
  await callAs(a.uid, 'blockUser', { targetUid: v.uid, matchId: id })
  await callAs(c.uid, 'blockUser', { targetUid: a.uid, matchId: other })
  await callAs(c.uid, 'unmatchConnection', { matchId: other }) // kept for Adam, by default
  expect((await db.doc(`matches/${other}`).get()).data()).toMatchObject({ users: [a.uid], preservedFor: [a.uid], blockedBy: c.uid })
  expect(await restGet(a.uid, `matches/${other}`)).toBe(200)
  const past = Timestamp.fromMillis(Date.now() - 1000)
  for (const m of [id, other]) await db.doc(`matches/${m}`).update({ preservedUntil: past })
  // Past the window, before the nightly job: the rules already say no.
  expect(await restGet(v.uid, `matches/${id}`)).toBe(403)

  const { fnLib } = await import('./helpers.mjs')
  expect(await fnLib('behavior').expirePreservedChats()).toEqual({ deleted: 1, released: 1 })
  const kept = (await db.doc(`matches/${id}`).get()).data()
  expect(kept).toMatchObject({ isBlocked: true, blockedBy: a.uid })
  for (const f of ['preservedFor', 'preservedUntil', 'preservedForReport']) expect(kept[f], f).toBeUndefined()
  expect(await restGet(v.uid, `matches/${id}/messages/${msg.id}`)).toBe(403)
  expect(await restGet(a.uid, `matches/${id}/messages/${msg.id}`)).toBe(200)
  expect((await db.doc(`matches/${other}`).get()).exists).toBe(false)
})

test('H5 in the app: he sends abuse and blocks her; she opens the chat, reads it (his key from the match), can\'t reply, and reports it with the message as verified evidence', async ({ browser }) => {
  const a = await seedUser('Ada')
  const v = await woman('Bea')
  const id = sortedPair(a.uid, v.uid)
  await db.doc(`matches/${id}`).set({
    matchId: id, users: [a.uid, v.uid].sort(), participants: [a.uid, v.uid].sort(), mode: 'spark',
    matchedAt: Timestamp.now(), createdAt: Timestamp.now(), matchGeneration: Date.now() - 1000, isBlocked: false, safetyCardShown: true,
    participantSnapshots: { [a.uid]: { displayName: 'Ada', age: 30 }, [v.uid]: { displayName: 'Bea', age: 30 } },
  })
  const device = async (user) => {
    const ctx = await browser.newContext(CONTEXT)
    const page = await ctx.newPage()
    const net = await offline(page)
    await quietFirstRun(page, user.uid)
    await signIn(page, user.phone, { expectPath: /\/discover/ })
    return { ctx, page, net }
  }
  const A = await device(a)
  const V = await device(v)
  for (const u of [a, v]) await expect.poll(async () => (await userDoc(u.uid)).publicKey?.length ?? 0, { timeout: 20000 }).toBeGreaterThan(20)
  await A.page.goto(`/chat/${id}`)
  const box = A.page.getByPlaceholder('Message Bea…')
  await expect(box).toBeVisible({ timeout: 20000 })
  await box.fill('you will regret ignoring me')
  await expect(A.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 20000 })
  await A.page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(async () => (await db.collection(`matches/${id}/messages`).get()).size, { timeout: 20000 }).toBe(1)
  const msgId = (await db.collection(`matches/${id}/messages`).get()).docs[0].id
  await expect.poll(async () => (await db.doc(`franking/${id}_${msgId}`).get()).exists, { timeout: 30000 }).toBe(true)
  // He blocks her from the chat.
  await A.page.getByRole('button', { name: 'More options' }).click()
  await A.page.getByRole('button', { name: 'Block Bea' }).click()
  await A.page.getByRole('button', { name: 'Block', exact: true }).click()
  await expect.poll(async () => (await db.doc(`matches/${id}`).get()).data()?.isBlocked).toBe(true)

  // She still has the conversation: decrypted, read-only, with the window.
  await V.page.goto(`/chat/${id}`)
  await expect(V.page.getByText('you will regret ignoring me')).toBeVisible({ timeout: 20000 })
  await expect(V.page.getByText(/This connection has ended\. This chat stays here, read-only and still encrypted, until .*, so you can still report it\./)).toBeVisible()
  await expect(V.page.getByPlaceholder('Message Ada…')).toHaveCount(0)
  // And reports it with the message attached.
  await V.page.getByRole('button', { name: 'More options' }).click()
  await V.page.getByRole('button', { name: 'Report Ada' }).click()
  await V.page.getByRole('button', { name: /I felt unsafe/ }).click()
  await V.page.getByRole('button', { name: 'Add evidence (choose messages)' }).click()
  await V.page.getByRole('checkbox', { name: 'Ada: you will regret ignoring me' }).check()
  await V.page.getByRole('button', { name: /^Review/ }).click()
  await V.page.getByRole('button', { name: 'Send report with 1 message' }).click()
  await expect(V.page.getByText(/Report sent/)).toBeVisible({ timeout: 20000 })
  const lockers = (await db.collection('evidenceLocker').get()).docs
  expect(lockers).toHaveLength(1)
  expect(lockers[0].data()).toMatchObject({ reporterUid: v.uid, reportedUid: a.uid, summary: { items: 1, verified: 1, mismatch: 0 } })
  for (const d of [A, V]) {
    expect(d.net.errors).toEqual([])
    await d.ctx.close()
  }
})

// ─── The migration (scripts/lib/blocks.mjs) ──────────────────────────────────

test('migration: recent blocked chats kept for both with keys; Explore hides moved to the block\'s mode; C1 anomalies counted; idempotent', async () => {
  const { a, v } = await players()
  const [c, d, e, f] = [await woman('Cleo'), await woman('Dot'), await woman('Eve'), await woman('Fay')]
  await db.doc(`users/${a.uid}`).update({ publicKey: KEY('A') })
  await db.doc(`users/${v.uid}`).update({ publicKey: KEY('V') })
  const ago = (days) => Timestamp.fromMillis(Date.now() - days * DAY)
  // As the old blockPair left them: Vera blocked Adam from their chat 2 days ago.
  const recent = await sparkMatch(a, v)
  const pm = await playMatch(a, v)
  const twoDaysAgo = ago(2)
  const old = { blockedBy: v.uid, mode: 'spark', blockedAt: twoDaysAgo }
  await db.doc(`users/${v.uid}/blockedUsers/${a.uid}`).set({ uid: a.uid, ...old })
  await db.doc(`users/${a.uid}/blockedUsers/${v.uid}`).set({ uid: v.uid, ...old })
  await db.doc(`matches/${recent}`).update({ isBlocked: true, blockedBy: v.uid, blockedAt: twoDaysAgo })
  await db.doc(`exploreState/${v.uid}`).set({ blocked: [a.uid] }, { merge: true })
  await db.doc(`exploreState/${a.uid}`).set({ blocked: [v.uid] }, { merge: true })
  // Blocked 40 days ago: left. Unmatched after the block: left.
  const older = await sparkMatch(a, c)
  await db.doc(`matches/${older}`).update({ isBlocked: true, blockedBy: a.uid, blockedAt: ago(40) })
  const gone = await sparkMatch(a, d)
  await db.doc(`matches/${gone}`).update({ isBlocked: true, blockedBy: a.uid, blockedAt: ago(1), unmatchedAt: ago(1), users: [d.uid], preservedFor: [d.uid], preservedUntil: Timestamp.fromMillis(Date.now() + 29 * DAY) })
  // C1 signs: the match names Eve, the records name Adam.
  const odd = await sparkMatch(a, e)
  await db.doc(`users/${a.uid}/blockedUsers/${e.uid}`).set({ uid: e.uid, blockedBy: a.uid, mode: 'spark' })
  await db.doc(`users/${e.uid}/blockedUsers/${a.uid}`).set({ uid: a.uid, blockedBy: a.uid, mode: 'spark' })
  await db.doc(`matches/${odd}`).update({ isBlocked: true, blockedBy: e.uid, blockedAt: ago(40) })
  // Mobile's record: no blocker.
  await db.doc(`users/${f.uid}/blockedUsers/${a.uid}`).set({ blockedAt: Date.now() })
  // Their Play chat, blocked yesterday.
  const [aPlay, vPlay] = [await playIdOf(a.uid), await playIdOf(v.uid)]
  await db.doc(`playMatches/${pm}`).update({ isBlocked: true, blockedBy: aPlay, blockedAt: ago(1) })

  const plan = await planBlocks({ db })
  expect(summaryBlocks(plan)).toEqual({
    'block record pairs': 3,
    'pairs with one record only': 1,
    'pairs whose two records name different blockers (look by hand)': 0,
    'records with no blocker or no mode (both modes, left as they are)': 1,
    'blockers whose Explore hide moves to one mode': 1,
    'blocked matches (Spark)': 4,
    'blocked matches (Play)': 1,
    // Eve's (a takeover's signs), and their Play chat: Adam blocked it, the
    // records (one per pair before this fix) say Vera.
    'blocked matches whose blocker differs from the block records (a C1 takeover, or each blocked the other — look by hand)': 2,
    'blocked chats kept read-only for both (blocked < 30 days ago)': 2,
    'blocked chats left (unmatched, already kept, older, or no block time)': 3,
    'docs backed up before any write': 3,
  })
  // Counts only — nothing written yet.
  expect((await db.doc(`matches/${recent}`).get()).data().preservedFor).toBeUndefined()
  expect(await restGet(a.uid, `matches/${recent}`)).toBe(403)

  await applyBlocks({ db, FieldValue, Timestamp }, plan)
  const m = (await db.doc(`matches/${recent}`).get()).data()
  expect(m).toMatchObject({ preservedFor: [a.uid, v.uid].sort(), preservedForReport: false, chatKeys: { [a.uid]: KEY('A'), [v.uid]: KEY('V') } })
  expect(m.preservedUntil.toMillis()).toBe(twoDaysAgo.toMillis() + 30 * DAY)
  expect(await restGet(a.uid, `matches/${recent}`)).toBe(200)
  expect((await db.doc(`playMatches/${pm}`).get()).data()).toMatchObject({ preservedFor: [aPlay, vPlay].sort() })
  expect(await restGet(v.uid, `playMatches/${pm}`)).toBe(200)
  for (const id of [older, odd]) expect((await db.doc(`matches/${id}`).get()).data().preservedFor).toBeUndefined()
  expect((await db.doc(`matches/${gone}`).get()).data().preservedFor).toEqual([d.uid])
  // Vera's Spark block hides Adam in Spark only now; he still can't see her anywhere.
  const vs = (await db.doc(`exploreState/${v.uid}`).get()).data()
  expect(vs.blocked).toEqual([])
  expect(vs.spark.blocked).toEqual([a.uid])
  expect((await db.doc(`exploreState/${a.uid}`).get()).data().blocked).toEqual([v.uid])

  expect(Object.values(summaryBlocks(await planBlocks({ db }))).slice(-3)).toEqual([0, 5, 0]) // nothing left to do (the two kept now count as kept already)
})
