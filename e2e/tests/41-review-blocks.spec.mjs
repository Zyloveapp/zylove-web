// Fresh-eyes review (2026-10-09), blocks: C1 (the person blocked took the
// block over — re-block, unblock, unmatch — in Spark and Play), H3 (a block
// you place in one mode changes nothing you're shown in the other; one
// placed on you holds in both) and H5 (whoever blocks first, the other
// person keeps the chat read-only for the 30-day report window, with the
// key to read it and evidence to attach).
import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, PROJECT, playIdOf, playMatchOf, sortedPair, setPlan, Timestamp,
} from './helpers.mjs'

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
