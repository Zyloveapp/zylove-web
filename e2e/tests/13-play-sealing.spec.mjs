import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, callAs, likeAs, idTokenFor, db, userDoc, internalDoc, sortedPair, FieldValue, Timestamp, PROJECT, PHOTO, playIdOf } from './helpers.mjs'
import { planStage2, applyStage2 } from '../../scripts/lib/stage2.mjs'

const require = createRequire(import.meta.url)
const { getStorage } = require('firebase-admin/storage')
const BUCKET = 'demo-zylove.appspot.com'

test.beforeEach(resetEmulators)

const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
async function restGet(uid, path) {
  return (await fetch(`${BASE}/${path}`, { headers: { Authorization: `Bearer ${await idTokenFor(uid)}` } })).status
}
// A structured query as the user (rules apply to the whole query).
async function restQuery(uid, parent, query) {
  const r = await fetch(`${BASE}${parent ? '/' + parent : ''}:runQuery`, {
    method: 'POST', headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: query }),
  })
  return r.status
}
const eq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } })

const PLAY = (name) => ({ playDisplayName: name, playBio: `${name}'s Play bio`, spiceLevel: 'spicy', playInterestTags: ['fwb'] })
const PLAY_ROOT = ['playDisplayName', 'playBio', 'spiceLevel', 'playInterestTags', 'playVisibility', 'intent', 'onboardingPath', 'mode', 'intentionAnswers']

async function seedPair() {
  // Root Play copies and Play-revealing metadata, as older accounts have them.
  // p1 is a man (no lifetime Elite), so his Play access can lapse with a trial.
  const p1 = await seedUser('Pia', { playBio: 'old root copy', spiceLevel: 'mild', intent: 'open', onboardingPath: 'both' }, { play: PLAY('Pia') })
  const p2 = await seedUser('Paz', { genderIdentity: 'woman', attractedTo: ['men'], intent: 'open' }, { play: PLAY('Paz') })
  const s = await seedUser('Sol') // Spark only
  return { p1, p2, s }
}

async function lapse(uid) {
  await db.doc(`userInternal/${uid}`).set({
    subscriptionTier: 'free',
    trialStartedAt: Timestamp.fromMillis(Date.now() - 40 * 86400000), trialEndsAt: Timestamp.fromMillis(Date.now() - 10 * 86400000), trialExpired: true,
  }, { merge: true })
  await expect.poll(async () => (await internalDoc(uid))?.playAccess, { timeout: 20000 }).toBe(false)
}
async function restore(uid) {
  await db.doc(`userInternal/${uid}`).set({ subscriptionTier: 'elite' }, { merge: true })
  await expect.poll(async () => (await internalDoc(uid))?.playAccess, { timeout: 20000 }).toBe(true)
}
// F-062: a Play match is playMatches/{pm_…}, its people by Play ID.
async function playMatch(a, b) {
  await likeAs(a.uid, b.uid, 'play')
  const { matchId: id } = await likeAs(b.uid, a.uid, 'play')
  expect(id).toMatch(/^pm_/)
  await expect.poll(async () => (await db.doc(`playMatches/${id}`).get()).data()?.mode, { timeout: 20000 }).toBe('play')
  await db.collection(`playMatches/${id}/messages`).add({ senderId: await playIdOf(a.uid), text: 'hi', sentAt: Date.now() })
  return id
}

test('sealing: nothing Play on any public doc; Play profiles readable only by viewers with Play access', async () => {
  const { p1, p2, s } = await seedPair()
  for (const u of [p1, p2, s]) {
    const d = await userDoc(u.uid)
    for (const f of PLAY_ROOT) expect(d[f], `${u.name}.${f}`).toBeUndefined()
  }
  // The Play profile kept its own values; the private profile got the intent.
  expect((await db.doc(`users/${p1.uid}/playProfile/data`).get()).data()).toMatchObject({ playBio: "Pia's Play bio", playDisplayName: 'Pia' })
  expect((await db.doc(`users/${p1.uid}/private/profile`).get()).data()).toMatchObject({ intent: 'open', onboardingPath: 'both' })
  expect(await internalDoc(p1.uid)).toMatchObject({ playEntitled: true, playAccess: true })
  expect(await internalDoc(s.uid)).toMatchObject({ playEntitled: true, playAccess: false }) // entitled, no Play profile

  // F-062: the Play profile itself is owner-only; others read the public
  // copy by Play ID, with Play access.
  const p1Play = await playIdOf(p1.uid)
  expect(await restGet(s.uid, `users/${p1.uid}/playProfile/data`)).toBe(403)
  expect(await restGet(p2.uid, `users/${p1.uid}/playProfile/data`)).toBe(403)
  expect(await restGet(p1.uid, `users/${p1.uid}/playProfile/data`)).toBe(200)
  expect(await restGet(s.uid, `playProfiles/${p1Play}`)).toBe(403)
  expect(await restGet(p2.uid, `playProfiles/${p1Play}`)).toBe(200)
  expect(await restGet(s.uid, `users/${p1.uid}/private/profile`)).toBe(403)
  expect(await restGet(p1.uid, `users/${p1.uid}/private/profile`)).toBe(200)
})

test('sealing: Play photos, Play scores and Play callables need Play access', async () => {
  const { p1, p2, s } = await seedPair()
  const [p1Play, p2Play] = [await playIdOf(p1.uid), await playIdOf(p2.uid)]
  const ref = `playPhotos/${p1Play}/p.png`
  await getStorage().bucket(BUCKET).file(ref).save(Buffer.from('89504e47', 'hex'), { contentType: 'image/png', metadata: { metadata: { zyloveCopy: '1' } } })
  await db.doc(`users/${p1.uid}/playProfile/data`).update({ photoURLs: [ref] })
  expect((await callAs(s.uid, 'getPhotoUrls', { refs: [ref] })).urls).toEqual({})
  expect(Object.keys((await callAs(p2.uid, 'getPhotoUrls', { refs: [ref] })).urls)).toEqual([ref])

  // A Spark-only tap: Spark data only, nowhere a Play score.
  const tap = await callAs(s.uid, 'onTap', { tappedUserId: p1.uid })
  expect(typeof tap.sparkScore).toBe('number')
  expect(tap.playScore).toBeUndefined()
  expect(tap.breakdown.play).toBeUndefined()
  const sp = sortedPair(s.uid, p1.uid)
  expect((await db.doc(`pairs/${sp}`).get()).data().playScore).toBeUndefined()
  expect((await db.doc(`pairs/${sp}/modes/play`).get()).exists).toBe(false)
  // Two Play users: Play scores (by Play ID), in the server-only subdoc.
  const both = await callAs(p1.uid, 'onTap', { tappedPlayId: p2Play })
  expect(typeof both.playScore).toBe('number')
  // F-065: never on the uid pair — in playPairData, keyed by the Play IDs.
  const pp = sortedPair(p1.uid, p2.uid)
  expect((await db.doc(`pairs/${pp}`).get()).exists).toBe(false)
  const ppd = `playPairData/${[await playIdOf(p1.uid), p2Play].sort().join('_')}`
  expect(typeof (await db.doc(ppd).get()).data().playScore).toBe('number')
  expect(await restGet(p1.uid, ppd)).toBe(403)

  for (const [fn, data] of [['recordSwipe', { targetUid: p1Play, action: 'like', mode: 'play' }], ['getSentSparks', { mode: 'play' }], ['onLike', { likedUserId: p1Play, mode: 'play' }]]) {
    await expect(callAs(s.uid, fn, data), fn).rejects.toThrow(/permission-denied|PERMISSION_DENIED/)
  }
  expect((await callAs(s.uid, 'getCuriousVisitors', { mode: 'play' })).visitors).toEqual([])
  // Not entitled at all (Spark+): no Play AI either.
  await db.doc(`userInternal/${s.uid}`).set({ subscriptionTier: 'spark_plus' }, { merge: true })
  await expect.poll(async () => (await internalDoc(s.uid))?.playEntitled, { timeout: 20000 }).toBe(false)
  await expect(callAs(s.uid, 'generatePlayBio', { answers: {} })).rejects.toThrow(/permission-denied|PERMISSION_DENIED/)
  // A Play like shows the liker's Play profile, never their Spark one.
  await likeAs(p1.uid, p2.uid, 'play')
  const q = (await db.doc(`users/${p2.uid}/likeQueue/${p1Play}`).get()).data()
  expect(q.mode).toBe('play')
  expect(q.likerProfile).toMatchObject({ displayName: 'Pia', bio: "Pia's Play bio" })
  expect(q.likerProfile.photoURLs).not.toContain(PHOTO) // the Spark photo
})

test('lapse: Play matches, chats and likes hidden; report, block and delete still work; all back on re-entitlement', async () => {
  const { p1, p2, s } = await seedPair()
  const matchId = await playMatch(p1, p2)
  const [p1Play, p2Play] = [await playIdOf(p1.uid), await playIdOf(p2.uid)]
  expect(await restGet(p1.uid, `playMatches/${matchId}`)).toBe(200)
  expect(await restGet(s.uid, `users/${p1.uid}/likeQueue/${p2Play}`)).toBe(403)

  await lapse(p1.uid)
  expect(await restGet(p1.uid, `playMatches/${matchId}`)).toBe(403)
  expect(await restQuery(p1.uid, `playMatches/${matchId}`, { from: [{ collectionId: 'messages' }] })).toBe(403)
  expect(await restQuery(p1.uid, '', { from: [{ collectionId: 'playMatches' }], where: { fieldFilter: { field: { fieldPath: 'players' }, op: 'ARRAY_CONTAINS', value: { stringValue: p1Play } } } })).toBe(403)
  expect(await restQuery(p1.uid, '', { from: [{ collectionId: 'matches' }], where: { compositeFilter: { op: 'AND', filters: [
    { fieldFilter: { field: { fieldPath: 'users' }, op: 'ARRAY_CONTAINS', value: { stringValue: p1.uid } } }, eq('mode', 'spark')] } } })).toBe(200)
  expect(await restGet(p1.uid, `playProfiles/${p2Play}`)).toBe(403)
  // The other side: the match is still theirs; the lapsed Play profile reads as unavailable.
  expect(await restGet(p2.uid, `playMatches/${matchId}`)).toBe(200)
  expect(await restGet(p2.uid, `playProfiles/${p1Play}`)).toBe(403)
  expect(await restGet(p1.uid, `users/${p1.uid}/playProfile/data`)).toBe(200) // own data kept
  await expect(callAs(p1.uid, 'generateConversationStarter', { matchId, otherUid: p2Play })).rejects.toThrow(/permission-denied|PERMISSION_DENIED/)

  // Guardrails: list, report and (later) block by match id only.
  expect((await callAs(p1.uid, 'listLockedPlayConnections')).connections.map((c) => c.matchId)).toEqual([matchId])
  expect((await callAs(p2.uid, 'listLockedPlayConnections')).connections).toEqual([])
  await callAs(p1.uid, 'actOnPlayConnection', { matchId, action: 'report', categories: ['felt_unsafe'] })
  expect((await db.collection('reports').where('reportedUid', '==', p2.uid).get()).size).toBe(1)
  await expect(callAs(s.uid, 'actOnPlayConnection', { matchId, action: 'block' })).rejects.toThrow(/not-found|NOT_FOUND/)

  // Back on re-entitlement, data intact.
  await restore(p1.uid)
  expect(await restGet(p1.uid, `playMatches/${matchId}`)).toBe(200)
  expect(await restQuery(p1.uid, `playMatches/${matchId}`, { from: [{ collectionId: 'messages' }] })).toBe(200)
  expect((await db.collection(`playMatches/${matchId}/messages`).get()).size).toBe(1)

  // Block while lapsed works too.
  await lapse(p1.uid)
  await callAs(p1.uid, 'actOnPlayConnection', { matchId, action: 'block' })
  expect((await db.doc(`users/${p1.uid}/blockedUsers/${p2.uid}`).get()).exists).toBe(true)
  expect((await db.doc(`playMatches/${matchId}`).get()).data().isBlocked).toBe(true)
  // And account deletion.
  expect((await callAs(p1.uid, 'requestAccountDeletion')).success).toBe(true)
})

test('lapse: a trial that ends takes effect at once in the rules (playAccessUntil)', async () => {
  const { p1, p2 } = await seedPair()
  const p2Play = await playIdOf(p2.uid)
  expect(await restGet(p1.uid, `playProfiles/${p2Play}`)).toBe(200)
  // The flags still say "access", but only until a moment that has passed.
  await db.doc(`userInternal/${p1.uid}`).set({ playAccess: true, playAccessUntil: Timestamp.fromMillis(Date.now() - 1000) }, { merge: true })
  expect(await restGet(p1.uid, `playProfiles/${p2Play}`)).toBe(403)
})

test('migration 2: Play fields, metadata, mirrored photos, pair scores, match and like modes', async () => {
  const p = await seedUser('Mig', { playBio: 'root bio', playDisplayName: 'RootName', playVisibility: 'paused', intent: 'play', onboardingPath: 'play', mode: 'play', intentionAnswers: ['fun_no_pressure'], openToCrossover: false }, { play: { playBio: 'play bio', photoURLs: [PHOTO] }, legacy: true })
  const q = await seedUser('Quin', { intent: 'spark' }, { legacy: true })
  await db.doc(`users/${p.uid}`).update({ photoURLs: [`photos/${p.uid}/play/m.png`] })
  // A mobile-era Play profile: in use (a photo) but no finished flag.
  await db.doc(`users/${p.uid}/playProfile/data`).update({ playOnboardingComplete: FieldValue.delete() })
  const pid = sortedPair(p.uid, q.uid)
  await db.doc(`pairs/${pid}`).set({ userA: [p.uid, q.uid].sort()[0], userB: [p.uid, q.uid].sort()[1], sparkScore: 50, playScore: 70, playBreakdown: {}, tier1Play: { a: 1 } })
  await db.doc(`matches/${pid}`).set({ users: [p.uid, q.uid], playScore: 70 })
  await db.doc(`users/${q.uid}/likeQueue/${p.uid}`).set({ likerUid: p.uid, likedAt: Date.now() })

  await applyStage2({ db, FieldValue }, await planStage2(db))
  const root = await userDoc(p.uid)
  for (const f of PLAY_ROOT) expect(root[f], f).toBeUndefined()
  expect(root.photoURLs).toEqual([])
  expect((await db.doc(`users/${p.uid}/playProfile/data`).get()).data()).toMatchObject({ playBio: 'play bio', playDisplayName: 'RootName', playVisibility: 'paused', playOnboardingComplete: true })
  expect((await db.doc(`users/${p.uid}/private/profile`).get()).data()).toEqual({ intent: 'play', onboardingPath: 'play', mode: 'play', intentionAnswers: ['fun_no_pressure'] })
  // Quin has no Play profile: the pair's Play scores are deleted, not moved.
  expect((await db.doc(`pairs/${pid}`).get()).data().playScore).toBeUndefined()
  expect((await db.doc(`pairs/${pid}/modes/play`).get()).exists).toBe(false)
  expect((await db.doc(`matches/${pid}`).get()).data()).toMatchObject({ mode: 'spark' })
  expect((await db.doc(`matches/${pid}`).get()).data().playScore).toBeUndefined()
  expect((await db.doc(`users/${q.uid}/likeQueue/${p.uid}`).get()).data().mode).toBe('spark')
  expect(await internalDoc(p.uid)).toMatchObject({ playEntitled: true, playAccess: true })
  // Second run: nothing to do.
  const again = await planStage2(db)
  expect(again.users.filter((u) => u.scrub.length || u.toPlay || u.toMeta || u.photos)).toEqual([])
  expect(again.pairs).toEqual([])
})

test('UI: the other person sees a neutral "unavailable" state; the lapsed user sees hidden Play connections with report/block', async ({ browser }) => {
  const { p1, p2 } = await seedPair()
  const matchId = await playMatch(p1, p2)
  await lapse(p1.uid)

  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, p2.uid)
  await page.addInitScript((m) => localStorage.setItem(`zylove_chat_seen_${m}`, '1'), matchId)
  await signIn(page, p2.phone, { expectPath: /\/discover/ })
  await page.goto(`/chat/${matchId}`)
  // A Play chat opened directly asks for the Play PIN first (Stage B PlayGate).
  await expect(page.getByText('Create your Play PIN')).toBeVisible({ timeout: 20000 })
  await page.keyboard.type('2468')
  await expect(page.getByText('Confirm your PIN')).toBeVisible()
  await page.keyboard.type('2468')
  await expect(page.getByText("This connection isn't available right now.")).toBeVisible({ timeout: 20000 })
  await expect(page.getByPlaceholder(/Message/)).toHaveCount(0)
  expect(net.errors).toEqual([])
  await ctx.close()

  const ctx2 = await browser.newContext(CONTEXT)
  const page2 = await ctx2.newPage()
  const net2 = await offline(page2)
  await quietFirstRun(page2, p1.uid)
  await signIn(page2, p1.phone, { expectPath: /\/discover/ })
  // The trial-ended screen blocks the app — safety is reachable from it.
  await expect(page2.getByText('Your free trial has ended.')).toBeVisible({ timeout: 20000 })
  await page2.getByRole('button', { name: 'Report or block a Play connection' }).click()
  await expect(page2.getByText('1 Play connection is hidden')).toBeVisible({ timeout: 20000 })
  await page2.getByRole('dialog', { name: 'Your free trial has ended.' }).getByRole('button', { name: 'Report', exact: true }).click()
  await page2.getByRole('button', { name: /I felt unsafe/ }).click()
  await page2.getByRole('button', { name: 'Send report' }).click()
  await expect(page2.getByText(/Report sent/)).toBeVisible({ timeout: 20000 })
  expect(net2.errors).toEqual([])
  await ctx2.close()
})

async function seedPlayFootprint() {
  const { p1, p2 } = await seedPair()
  const ref = `photos/${p1.uid}/play/f.png`
  await getStorage().bucket(BUCKET).file(ref).save(Buffer.from('89504e47', 'hex'), { contentType: 'image/png', metadata: { metadata: { zyloveCopy: '1' } } })
  await db.doc(`users/${p1.uid}/playProfile/data`).update({ photoURLs: [ref] })
  await db.doc(`users/${p1.uid}/settings/playPin`).set({ hash: 'x' })
  const matchId = await playMatch(p1, p2) // also the pair + its Play scores
  const [p1Play, p2Play] = [await playIdOf(p1.uid), await playIdOf(p2.uid)]
  // A Play like each way still in a queue (as if sent before the match).
  await db.doc(`users/${p2.uid}/likeQueue/${p1Play}`).set({ likerPlayId: p1Play, mode: 'play', likedAt: Date.now(), likerProfile: { displayName: 'Pia' } })
  await db.doc(`users/${p1.uid}/likeQueue/${p2Play}`).set({ likerPlayId: p2Play, mode: 'play', likedAt: Date.now(), likerProfile: { displayName: 'Paz' } })
  expect((await db.doc(`playPairData/${[p1Play, p2Play].sort().join('_')}`).get()).exists).toBe(true)
  return { p1, p2, matchId, ref, p1Play, p2Play }
}

async function expectNoPlayLeft(p1, p2, matchId, ref, p1Play, p2Play) {
  for (const path of [
    `users/${p1.uid}/playProfile/data`, `users/${p1.uid}/settings/playPin`, `users/${p1.uid}/settings/pause`, `users/${p1.uid}/private/profile`,
    `userInternal/${p1.uid}`, `playPairData/${[p1Play, p2Play].sort().join('_')}`, `users/${p2.uid}/likeQueue/${p1Play}`, `users/${p1.uid}/likeQueue/${p2Play}`,
    // F-062: the public Play profile and the Play ID mapping go too.
    `playProfiles/${p1Play}`, `playIds/${p1.uid}`, `playIdOwners/${p1Play}`,
  ]) expect((await db.doc(path).get()).exists, path).toBe(false)
  expect((await getStorage().bucket(BUCKET).file(ref).exists())[0]).toBe(false)
  const root = await userDoc(p1.uid)
  for (const f of PLAY_ROOT) expect(root[f], f).toBeUndefined()
  expect((await db.doc(`playMatches/${matchId}`).get()).data().participantSnapshots[p1Play]).toMatchObject({ displayName: 'Deleted User', photoURL: null })
  // The other person's own Play data is untouched.
  expect((await db.doc(`users/${p2.uid}/playProfile/data`).get()).exists).toBe(true)
}

test('deletion: deleting an account with a Play profile leaves no Play data behind', async () => {
  const { p1, p2, matchId, ref, p1Play, p2Play } = await seedPlayFootprint()
  expect((await callAs(p1.uid, 'deleteAccount')).success).toBe(true)
  await expectNoPlayLeft(p1, p2, matchId, ref, p1Play, p2Play)
})

test('deletion: the grace-period path (requestAccountDeletion → processGraceExpiredDeletions) does the same', async () => {
  const { p1, p2, matchId, ref, p1Play, p2Play } = await seedPlayFootprint()
  await callAs(p1.uid, 'requestAccountDeletion')
  await db.doc(`deletionRequests/${p1.uid}`).update({ scheduledFor: Timestamp.fromMillis(Date.now() - 1000) })
  const WEB_FN = new URL('../web-fn/', import.meta.url).pathname
  const fnRequire = createRequire(`${WEB_FN}package.json`)
  const app = fnRequire('firebase-admin/app')
  if (!app.getApps().length) app.initializeApp({ projectId: 'demo-zylove', storageBucket: BUCKET })
  await fnRequire(`${WEB_FN}lib/legacy/onNightlyPurge.js`).processGraceExpiredDeletions.run({})
  expect((await db.doc(`deletionRequests/${p1.uid}`).get()).data().status).toBe('processed')
  await expectNoPlayLeft(p1, p2, matchId, ref, p1Play, p2Play)
})
