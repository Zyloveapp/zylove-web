// §4.A3 (2026-10-09): anonymous likers. The liked person's app never gets
// the liker's uid (or Play ID) before they link: the like queue is
// server-only, getLikes names each like by an opaque like id, getLikerPreview
// returns only what the plan allows (Free: nothing — the count comes from
// getLikes; Spark+ / Elite: photo, first name, bio, prompts), and likeBack
// takes the like id. Hidden likers (blocked either way, suspended, deleted)
// aren't listed, counted or previewed. Play stays sealed. F-098: no score
// breakdown or dealbreakers on anything the liked person reads. Plus the
// migration (scripts/lib/a3Likes.mjs).
import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import {
  resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, PROJECT, setPlan, playIdOf, playMatchOf, sortedPair, likeIdOf, FieldValue,
} from './helpers.mjs'
import { applyA3Likes, planA3Likes, summary } from '../../scripts/lib/a3Likes.mjs'

const require = createRequire(new URL('../web-fn/package.json', import.meta.url).pathname)
const { getStorage } = require('firebase-admin/storage')
const BUCKET = 'demo-zylove.appspot.com'
const JPEG = readFileSync(new URL('../fixture.jpg', import.meta.url))

test.beforeEach(resetEmulators)

const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
const auth = async (uid) => ({ Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' })
async function restGet(uid, path) {
  return (await fetch(`${BASE}/${path}`, { headers: await auth(uid) })).status
}
async function restQuery(uid, parent, structuredQuery) {
  return (await fetch(`${parent ? `${BASE}/${parent}` : BASE}:runQuery`, { method: 'POST', headers: await auth(uid), body: JSON.stringify({ structuredQuery }) })).status
}
async function restWrite(uid, path, fields) {
  return (await fetch(`${BASE}/${path}`, { method: 'PATCH', headers: await auth(uid), body: JSON.stringify({ fields }) })).status
}

const woman = (name, o = {}, opts = {}) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o }, opts)
const PLAY = (name) => ({ playDisplayName: name, playBio: `${name}'s Play bio`, spiceLevel: 'spicy', playInterestTags: ['fwb'], promptAnswers: [{ promptId: 'wild_card', answer: `${name} after dark` }] })

// Fails with where it was found if any of `ids` is in `text`.
function expectNone(text, ids, where) {
  for (const id of ids) {
    if (id && text.includes(id)) throw new Error(`${id} found in ${where}: …${text.slice(Math.max(0, text.indexOf(id) - 80), text.indexOf(id) + 80)}…`)
  }
}
const PREVIEW_KEYS = ['bio', 'curated', 'firstName', 'mode', 'photo', 'prompts']
const ENTRY_KEYS = ['compatibilityScore', 'curated', 'dismissed', 'expiresAt', 'isWeeklySpark', 'likeId', 'likedAt', 'mode']

// Women are Elite by identity (entitlements.ts), so the Free and Spark+
// viewers here are men.
test('Free: the count only — no list, no preview, no like back', async () => {
  const me = await seedUser('Finn')
  await setPlan(me.uid, 'free')
  const liker = await woman('Gia')
  await likeAs(liker.uid, me.uid)
  const r = await callAs(me.uid, 'getLikes', { mode: 'spark' })
  expect(r).toEqual({ count: 1, likes: [] })
  // Even holding the like id (only a test can read it), nothing comes back.
  const likeId = await likeIdOf(me.uid, liker.uid)
  expect(likeId).toMatch(/^lk_[A-Za-z0-9]{20}$/)
  await expect(callAs(me.uid, 'getLikerPreview', { likeId })).rejects.toThrow(/permission-denied|PERMISSION_DENIED/)
  await expect(callAs(me.uid, 'likeBack', { likeId })).rejects.toThrow(/permission-denied|PERMISSION_DENIED/)
  // The old callable: the count, no uids.
  const old = await callAs(me.uid, 'getLikeCount', { mode: 'spark' })
  expect(old).toEqual({ count: 1, bots: [] })
})

test('Spark+ and Elite: a preview — photo, first name, bio, prompts — and no uid anywhere; no breakdown or dealbreakers (F-098)', async () => {
  const plus = await seedUser('Pat')
  const elite = await woman('Eve')
  await setPlan(plus.uid, 'spark_plus')
  await setPlan(elite.uid, 'elite')
  const liker = await seedUser('Gray Allen', { dealbreakers: ['smoking'], drinkingHabit: 'never', smokingHabit: 'never', pronouns: 'he/him' })
  // A real stored photo: its path names the liker, so it must arrive inline.
  const path = `photos/${liker.uid}/spark/p1.jpg`
  await getStorage().bucket(BUCKET).file(path).save(JPEG, { contentType: 'image/jpeg', metadata: { metadata: { zyloveCopy: '1' } } })
  await db.doc(`users/${liker.uid}`).update({ photoURLs: [path] })
  for (const me of [plus, elite]) {
    await likeAs(liker.uid, me.uid)
    const likes = await callAs(me.uid, 'getLikes', { mode: 'spark' })
    expect(likes.count).toBe(1)
    expect(likes.likes).toHaveLength(1)
    expect(Object.keys(likes.likes[0]).sort()).toEqual(ENTRY_KEYS)
    const listJson = JSON.stringify(likes)
    expectNone(listJson, [liker.uid, 'Gray', 'breakdown', 'dealbreaker', 'smoking'], 'getLikes')

    const r = await callAs(me.uid, 'getLikerPreview', { likeId: likes.likes[0].likeId })
    expect(Object.keys(r.preview).sort()).toEqual(PREVIEW_KEYS)
    expect(r.preview).toMatchObject({ mode: 'spark', firstName: 'Gray', bio: "Hi, I'm Gray Allen.", curated: false })
    expect(r.preview.prompts.map((p) => p.answer)).toEqual(['Coffee and a long walk', 'Kindness', 'My garden'])
    expect(r.preview.photo).toMatch(/^data:image\/jpeg;base64,/)
    const json = JSON.stringify(r)
    expectNone(json, [liker.uid, 'photos/', 'Austin', 'he/him', 'smoking', 'breakdown', 'dealbreaker'], 'getLikerPreview')

    // The server-only queue doc no longer keeps the score's details.
    const q = (await db.doc(`users/${me.uid}/likeQueue/${liker.uid}`).get()).data()
    expect(q.breakdown).toBeUndefined()
    expect(q.dealbreakersTriggered).toBeUndefined()
  }
  // A malformed or someone else's like id: the same "not available".
  await expect(callAs(plus.uid, 'getLikerPreview', { likeId: liker.uid })).rejects.toThrow(/likeId required/)
  await expect(callAs(plus.uid, 'getLikerPreview', { likeId: await likeIdOf(elite.uid, liker.uid) })).rejects.toThrow(/isn't available/)
})

test('rules: the liked person can\'t read who liked them — the queue, pair likes and Play like state are server-only', async () => {
  const me = await woman('Fay')
  await setPlan(me.uid, 'elite')
  const liker = await seedUser('Gray', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ember') })
  const meP = await woman('Faye', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Velvet') })
  for (const u of [liker, meP]) await setPlan(u.uid, 'elite')
  await likeAs(liker.uid, me.uid)
  await likeAs(liker.uid, meP.uid, 'play')
  const lp = await playIdOf(liker.uid)
  const mp = await playIdOf(meP.uid)
  expect(await restQuery(me.uid, `users/${me.uid}`, { from: [{ collectionId: 'likeQueue' }] })).toBe(403)
  expect(await restGet(me.uid, `users/${me.uid}/likeQueue/${liker.uid}`)).toBe(403)
  expect(await restGet(meP.uid, `users/${meP.uid}/likeQueue/${lp}`)).toBe(403)
  expect(await restGet(me.uid, `pairs/${sortedPair(me.uid, liker.uid)}/likes/spark`)).toBe(403)
  expect(await restGet(meP.uid, `playPairData/${[lp, mp].sort().join('_')}`)).toBe(403)
  // A collection-group query over everyone's likes is refused too.
  expect(await restQuery(me.uid, '', { from: [{ collectionId: 'likeQueue', allDescendants: true }] })).toBe(403)
  expect(await restQuery(me.uid, '', { from: [{ collectionId: 'likes', allDescendants: true }] })).toBe(403)
  // No client writes: not a forged like, not a dismiss.
  expect(await restWrite(me.uid, `users/${me.uid}/likeQueue/${liker.uid}`, { dismissed: { booleanValue: true } })).toBe(403)
  expect(await restWrite(me.uid, `users/${me.uid}/likeQueue/zbot-x`, { mode: { stringValue: 'spark' } })).toBe(403)
})

test('like back from a preview, by like id, creates the match the way a like does', async () => {
  const me = await woman('Fran')
  await setPlan(me.uid, 'spark_plus')
  const liker = await seedUser('Gray')
  await likeAs(liker.uid, me.uid)
  const [likeEntry] = (await callAs(me.uid, 'getLikes', { mode: 'spark' })).likes
  await callAs(me.uid, 'getLikerPreview', { likeId: likeEntry.likeId })
  const r = await callAs(me.uid, 'likeBack', { likeId: likeEntry.likeId })
  const pid = sortedPair(me.uid, liker.uid)
  // Only now, linked, does the app learn who it was.
  expect(r).toEqual({ matched: true, matchId: pid, partnerId: liker.uid })
  const m = (await db.doc(`matches/${pid}`).get()).data()
  expect(m).toMatchObject({ users: [me.uid, liker.uid].sort(), mode: 'spark', isBlocked: false })
  expect(m.participantSnapshots[liker.uid].displayName).toBe('Gray')
  expect(m.participantSnapshots[me.uid].displayName).toBe('Fran')
  expect(typeof m.sparkScore).toBe('number')
  // Both likes recorded (onLike's path), both queue entries consumed, both indexed.
  expect((await db.doc(`pairs/${pid}/likes/spark`).get()).data().likedBy.sort()).toEqual([me.uid, liker.uid].sort())
  expect((await db.doc(`users/${me.uid}/likeQueue/${liker.uid}`).get()).exists).toBe(false)
  expect((await db.doc(`users/${liker.uid}/likeQueue/${me.uid}`).get()).exists).toBe(false)
  expect((await db.doc(`users/${me.uid}/matches/${pid}`).get()).data().otherUid).toBe(liker.uid)
  expect((await db.doc(`users/${liker.uid}/matches/${pid}`).get()).data().otherUid).toBe(me.uid)
  expect(await callAs(me.uid, 'getLikes', { mode: 'spark' })).toEqual({ count: 0, likes: [] })
  // The like id is spent.
  await expect(callAs(me.uid, 'likeBack', { likeId: likeEntry.likeId })).rejects.toThrow(/isn't available/)
})

test('blocked (either way), suspended and deleted likers aren\'t previewed, counted or liked back', async () => {
  const me = await woman('Fran')
  await setPlan(me.uid, 'elite')
  const [a, b, c, d, e, ok] = [await seedUser('Al'), await seedUser('Bo'), await seedUser('Cy'), await seedUser('Di'), await seedUser('Ed'), await seedUser('Oz')]
  for (const u of [a, b, c, d, e, ok]) await likeAs(u.uid, me.uid)
  expect((await callAs(me.uid, 'getLikes', { mode: 'spark' })).count).toBe(6)
  const ids = {}
  for (const u of [a, b, c, d, e]) ids[u.uid] = await likeIdOf(me.uid, u.uid)

  await db.doc(`userInternal/${a.uid}`).set({ isSuspended: true }, { merge: true }) // suspended
  await db.doc(`users/${b.uid}`).update({ isDeleted: true }) // deleted
  await db.doc(`users/${c.uid}/blockedUsers/${me.uid}`).set({ blockedBy: c.uid }) // they blocked me
  await db.doc(`users/${me.uid}/blockedUsers/${d.uid}`).set({ blockedBy: me.uid }) // I blocked them
  await callAs(e.uid, 'blockUser', { targetUid: me.uid }) // the real block (it also clears likes)

  const r = await callAs(me.uid, 'getLikes', { mode: 'spark' })
  expect(r.count).toBe(1)
  expect(r.likes).toHaveLength(1)
  expect(r.likes[0].likeId).toBe(await likeIdOf(me.uid, ok.uid))
  expect((await callAs(me.uid, 'getLikeCount', { mode: 'spark' })).count).toBe(1)
  for (const [uid, likeId] of Object.entries(ids)) {
    if (!likeId) continue
    for (const fn of ['getLikerPreview', 'likeBack', 'dismissLike']) {
      await expect(callAs(me.uid, fn, { likeId }), `${fn} ${uid}`).rejects.toThrow(/isn't available/)
    }
  }
  for (const u of [a, b, c, d, e]) expect((await db.doc(`matches/${sortedPair(me.uid, u.uid)}`).get()).exists).toBe(false)
})

test('Play stays sealed: a Play like previews the Play profile — no uid, no Play ID, nothing from Spark — and never shows in Spark', async () => {
  const p1 = await seedUser('Adam', { intent: 'open', onboardingPath: 'both', bio: 'Adam Spark bio' }, { play: PLAY('Ember') })
  const p2 = await woman('Bella', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Velvet') })
  const sparkOnly = await woman('Sol')
  for (const u of [p1, p2]) await setPlan(u.uid, 'elite')
  await setPlan(sparkOnly.uid, 'spark_plus')
  const p1Play = await playIdOf(p1.uid)
  await likeAs(p1.uid, p2.uid, 'play')

  const likes = await callAs(p2.uid, 'getLikes', { mode: 'play' })
  expect(likes.count).toBe(1)
  expect(likes.likes[0].mode).toBe('play')
  expectNone(JSON.stringify(likes), [p1.uid, p1Play, 'Adam', 'Ember'], 'getLikes (Play)')
  // Not in Spark.
  expect(await callAs(p2.uid, 'getLikes', { mode: 'spark' })).toEqual({ count: 0, likes: [] })

  const r = await callAs(p2.uid, 'getLikerPreview', { likeId: likes.likes[0].likeId })
  expect(r.preview).toMatchObject({ mode: 'play', firstName: 'Ember', bio: "Ember's Play bio", prompts: [{ promptId: 'wild_card', answer: 'Ember after dark' }] })
  const json = JSON.stringify(r)
  expectNone(json, [p1.uid, p1Play, 'Adam', 'Spark bio', 'Coffee and a long walk', 'Austin'], 'getLikerPreview (Play)')

  // A Spark like between the same two shows the Spark profile, never the Play one.
  await likeAs(p1.uid, p2.uid, 'spark')
  const sparkLikes = await callAs(p2.uid, 'getLikes', { mode: 'spark' })
  const sp = await callAs(p2.uid, 'getLikerPreview', { likeId: sparkLikes.likes[0].likeId })
  expect(sp.preview).toMatchObject({ mode: 'spark', firstName: 'Adam', bio: 'Adam Spark bio' })
  expectNone(JSON.stringify(sp), [p1.uid, p1Play, 'Ember', 'Play bio', 'after dark'], 'getLikerPreview (Spark)')

  // No Play access: no Play likes at all.
  await expect(callAs(sparkOnly.uid, 'getLikes', { mode: 'play' })).rejects.toThrow(/permission-denied|PERMISSION_DENIED/)

  // Like back by like id: a Play match, Play IDs only; the partner named by Play ID.
  const back = await callAs(p2.uid, 'likeBack', { likeId: likes.likes[0].likeId })
  expect(back.partnerId).toBe(p1Play)
  expect(back.matchId).toMatch(/^pm_[A-Za-z0-9]{20}$/)
  expect(await playMatchOf(p1.uid, p2.uid)).toBe(back.matchId)
  // The Spark like is untouched.
  expect((await callAs(p2.uid, 'getLikes', { mode: 'spark' })).count).toBe(1)
})

test('curated likes show on every plan; Not for me and a pass from the profile page move a like to Viewed', async () => {
  const me = await seedUser('Finn')
  await setPlan(me.uid, 'free')
  const bot = 'zbot-e2e-a3-1'
  await db.doc(`users/${bot}`).set({ uid: bot, displayName: 'Ivy Curated', age: 29, bio: 'Bot bio', photoURLs: ['https://e2e.invalid/bot.png'], isBot: true, onboardingComplete: true })
  await db.doc(`users/${me.uid}/likeQueue/${bot}`).set({ likerUid: bot, mode: 'spark', likedAt: Date.now(), compatibilityScore: 75, dismissed: false })
  const r = await callAs(me.uid, 'getLikes', { mode: 'spark' })
  expect(r.count).toBe(0) // real people only
  expect(r.likes).toHaveLength(1)
  expect(r.likes[0]).toMatchObject({ curated: true, compatibilityScore: null })
  // getLikes gave the older doc its like id.
  expect(await likeIdOf(me.uid, bot)).toBe(r.likes[0].likeId)
  const p = await callAs(me.uid, 'getLikerPreview', { likeId: r.likes[0].likeId })
  expect(p.preview).toMatchObject({ firstName: 'Ivy', curated: true, photo: 'https://e2e.invalid/bot.png' })
  expectNone(JSON.stringify(p), [bot], 'curated preview')
  await callAs(me.uid, 'dismissLike', { likeId: r.likes[0].likeId })
  expect((await callAs(me.uid, 'getLikes', { mode: 'spark' })).likes[0].dismissed).toBe(true)

  // A pass on someone's profile page dismisses their like (server-side).
  const plus = await seedUser('Pat')
  await setPlan(plus.uid, 'spark_plus')
  const liker = await woman('Gia')
  await likeAs(liker.uid, plus.uid)
  await callAs(plus.uid, 'recordSwipe', { targetUid: liker.uid, action: 'pass', mode: 'spark' })
  const after = await callAs(plus.uid, 'getLikes', { mode: 'spark' })
  expect(after.count).toBe(0)
  expect(after.likes[0].dismissed).toBe(true)
})

test('migration: like ids added to older docs (hidden ones skipped), F-098 details dropped; idempotent', async () => {
  const me = await woman('Fran')
  await setPlan(me.uid, 'spark_plus')
  const [a, b, c] = [await seedUser('Al'), await seedUser('Bo'), await seedUser('Cy')]
  const legacy = (uid, extra = {}) => ({ likerUid: uid, mode: 'spark', likedAt: Date.now(), compatibilityScore: 70, breakdown: { values: 90 }, dealbreakersTriggered: ['smoking'], ...extra })
  await db.doc(`users/${me.uid}/likeQueue/${a.uid}`).set(legacy(a.uid))
  await db.doc(`users/${me.uid}/likeQueue/${b.uid}`).set(legacy(b.uid))
  await db.doc(`users/${me.uid}/likeQueue/${c.uid}`).set(legacy(c.uid, { likeId: 'lk_AAAAAAAAAAAAAAAAAAAA' }))
  await db.doc(`userInternal/${b.uid}`).set({ isSuspended: true }, { merge: true })

  const plan = await planA3Likes({ db })
  const s = summary(plan)
  expect(s['Like queue docs (Spark)']).toBe(3)
  expect(s['Already have a like id (Spark)']).toBe(1)
  expect(s['Like ids to add (Spark)']).toBe(1)
  expect(s['Skipped, hidden — spark: liker suspended']).toBe(1)
  expect(s['F-098: docs losing breakdown / dealbreakersTriggered']).toBe(3)
  expect(JSON.stringify(s)).not.toContain(a.uid)
  expect(Object.keys(plan.backup).sort()).toEqual([a, b, c].map((u) => `users/${me.uid}/likeQueue/${u.uid}`).sort())
  expect(await applyA3Likes({ db, FieldValue }, plan)).toBe(3)

  const qa = (await db.doc(`users/${me.uid}/likeQueue/${a.uid}`).get()).data()
  expect(qa.likeId).toMatch(/^lk_[A-Za-z0-9]{20}$/)
  const qb = (await db.doc(`users/${me.uid}/likeQueue/${b.uid}`).get()).data()
  expect(qb.likeId).toBeUndefined()
  for (const u of [a, b, c]) {
    const q = (await db.doc(`users/${me.uid}/likeQueue/${u.uid}`).get()).data()
    expect(q.breakdown).toBeUndefined()
    expect(q.dealbreakersTriggered).toBeUndefined()
  }
  expect((await db.doc(`users/${me.uid}/likeQueue/${c.uid}`).get()).get('likeId')).toBe('lk_AAAAAAAAAAAAAAAAAAAA')
  // The app sees the migrated ids.
  const listed = (await callAs(me.uid, 'getLikes', { mode: 'spark' })).likes.map((l) => l.likeId).sort()
  expect(listed).toEqual([qa.likeId, 'lk_AAAAAAAAAAAAAAAAAAAA'].sort())

  const again = summary(await planA3Likes({ db }))
  expect(again['Like ids to add (Spark)']).toBe(0)
  expect(again['F-098: docs losing breakdown / dealbreakersTriggered']).toBe(0)
})
