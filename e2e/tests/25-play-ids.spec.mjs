// F-062 (2026-10): private Play IDs. In Play everyone is known by an opaque
// Play ID; no real uid reaches a Play user in anything they read or receive —
// cards, likes, the like queue, matches, chats, typing, photo paths, callable
// answers — and nothing they're shown leads to a Spark profile. The mapping
// is server-only. Plus the migration (Play IDs, photos moved, Play matches and
// likes reset).
import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import {
  resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, fnLib, signIn, offline, quietFirstRun, CONTEXT, PROJECT,
  playIdOf, playMatchOf, FieldValue, sortedPair, PHOTO, setPlan,
} from './helpers.mjs'
import { applyF062, planF062, summary } from '../../scripts/lib/f062.mjs'

const require = createRequire(import.meta.url)
const { getStorage } = require('firebase-admin/storage')
const BUCKET = 'demo-zylove.appspot.com'

test.beforeEach(resetEmulators)

const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
async function rest(uid, path, init = {}) {
  const r = await fetch(`${BASE}/${path}`, { ...init, headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  return { status: r.status, text: await r.text() }
}
async function restQuery(uid, parent, structuredQuery) {
  const r = await fetch(`${BASE}${parent ? '/' + parent : ''}:runQuery`, {
    method: 'POST', headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery }),
  })
  return { status: r.status, text: await r.text() }
}
const contains = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'ARRAY_CONTAINS', value: { stringValue: value } } })
const eq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } })

// Spark and Play names differ, so a Spark leak is visible too.
const PLAY = (name) => ({ playDisplayName: name, playBio: `${name}'s Play bio`, spiceLevel: 'spicy', playInterestTags: ['fwb'] })

async function seedPlayers() {
  const a = await seedUser('Adam', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ember') })
  const b = await seedUser('Bella', { genderIdentity: 'woman', attractedTo: ['men'], bio: 'Bella Spark bio', intent: 'open', onboardingPath: 'both' }, { play: PLAY('Velvet') })
  // Elite (Play, the like list, Curious), set the way the server decides it.
  for (const u of [a, b]) await setPlan(u.uid, 'elite')
  return { a, b }
}

// Fails with where it was found if any of `uids` is in `text`.
function expectNoUid(text, uids, where) {
  for (const u of uids) {
    if (text.includes(u)) throw new Error(`uid ${u} found in ${where}: …${text.slice(Math.max(0, text.indexOf(u) - 80), text.indexOf(u) + 80)}…`)
  }
}

test('no uid in anything a Play user reads or gets back: deck, likes, like queue, match, messages, typing, profiles, callables', async () => {
  const { a, b } = await seedPlayers()
  const spark = await seedUser('Sol') // Spark only — never in Play
  const others = [b.uid, spark.uid]
  const [aPlay, bPlay] = [await playIdOf(a.uid), await playIdOf(b.uid)]
  expect(aPlay).toMatch(/^p_[A-Za-z0-9]{20}$/)
  expect(bPlay).not.toBe(aPlay)

  // Explore (Play): cards by Play ID, the Play profile and age only.
  const deck = await callAs(a.uid, 'getExploreDeck', { mode: 'play' })
  const card = deck.cards.find((c) => c.playId === bPlay)
  expect(card).toBeTruthy()
  expect(card.uid).toBeUndefined()
  expect(card.profile).toBeUndefined()
  expect(card.playProfile).toMatchObject({ playDisplayName: 'Velvet', age: 30 })
  expect(JSON.stringify(card)).not.toMatch(/Bella|Austin|phone_verified/)
  expectNoUid(JSON.stringify(deck), others, 'getExploreDeck')

  // Compatibility and a like, by Play ID.
  const tap = await callAs(a.uid, 'onTap', { tappedPlayId: bPlay })
  expect(tap.pairId).toBeUndefined()
  expect(tap.sparkScore).toBeUndefined()
  expectNoUid(JSON.stringify(tap), others, 'onTap')
  const liked = await callAs(a.uid, 'onLike', { likedUserId: bPlay, mode: 'play' })
  expect(liked).toEqual({ matched: false, matchId: null })
  // A uid instead of a Play ID is refused the same as an unknown one.
  await expect(callAs(a.uid, 'onLike', { likedUserId: b.uid, mode: 'play' })).rejects.toThrow(/isn't available/)
  await expect(callAs(a.uid, 'onTap', { tappedPlayId: b.uid })).rejects.toThrow(/isn't available/)

  // B's like queue: keyed by A's Play ID, nothing of A's account.
  const queue = await restQuery(b.uid, `users/${b.uid}`, { from: [{ collectionId: 'likeQueue' }], where: eq('mode', 'play') })
  expect(queue.status).toBe(200)
  expect(queue.text).toContain(`likeQueue/${aPlay}`)
  expect(queue.text).toContain('Ember')
  expectNoUid(queue.text, [a.uid], 'likeQueue')
  expect(queue.text).not.toMatch(/Adam/)
  expectNoUid(JSON.stringify(await callAs(b.uid, 'getLikeCount', { mode: 'play' })), [a.uid], 'getLikeCount')
  expectNoUid(JSON.stringify(await callAs(a.uid, 'getSentSparks', { mode: 'play' })), others, 'getSentSparks')
  await callAs(b.uid, 'recordPlayReveal', { playId: aPlay })
  expectNoUid(JSON.stringify(await callAs(a.uid, 'getCuriousVisitors', { mode: 'play' })), others, 'getCuriousVisitors')

  // Like back → a Play match with its own id, Play IDs only.
  const back = await callAs(b.uid, 'likeBack', { likerUid: aPlay, mode: 'play' })
  expect(back.matchId).toMatch(/^pm_[A-Za-z0-9]{20}$/)
  expect(await playMatchOf(a.uid, b.uid)).toBe(back.matchId)
  expect((await db.doc(`matches/${sortedPair(a.uid, b.uid)}`).get()).exists).toBe(false)
  const m = await rest(a.uid, `playMatches/${back.matchId}`)
  expect(m.status).toBe(200)
  expect(m.text).toContain(bPlay)
  expectNoUid(m.text, [a.uid, b.uid], 'playMatches doc')
  const list = await restQuery(a.uid, '', { from: [{ collectionId: 'playMatches' }], where: contains('players', aPlay) })
  expect(list.status).toBe(200)
  expectNoUid(list.text, [a.uid, b.uid], 'playMatches query')
  const idx = await rest(a.uid, `users/${a.uid}/matches/${back.matchId}`)
  expectNoUid(idx.text, [b.uid], 'match index')

  // Messages are sent as your Play ID — your uid is refused.
  const msg = (sender) => ({ fields: { senderId: { stringValue: sender }, ciphertext: { stringValue: 'c' }, nonce: { stringValue: 'n' }, messageType: { stringValue: 'text' }, status: { stringValue: 'sent' } } })
  const send = async (uid, sender) =>
    (await fetch(`${BASE}:commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writes: [{
          update: { name: `projects/${PROJECT}/databases/(default)/documents/playMatches/${back.matchId}/messages/m${Math.random().toString(36).slice(2)}`, ...msg(sender) },
          updateTransforms: [{ fieldPath: 'sentAt', setToServerValue: 'REQUEST_TIME' }],
        }],
      }),
    })).status
  expect(await send(a.uid, a.uid)).toBe(403)
  expect(await send(a.uid, bPlay)).toBe(403)
  expect(await send(a.uid, aPlay)).toBe(200)
  const msgs = await rest(b.uid, `playMatches/${back.matchId}/messages`)
  expect(msgs.status).toBe(200)
  expectNoUid(msgs.text, [a.uid], 'messages')
  // Typing is keyed by Play ID.
  expect((await rest(a.uid, `playMatches/${back.matchId}/typing/${a.uid}`, { method: 'PATCH', body: JSON.stringify({ fields: { uid: { stringValue: a.uid } } }) })).status).toBe(403)
  expect((await rest(a.uid, `playMatches/${back.matchId}/typing/${aPlay}`, { method: 'PATCH', body: JSON.stringify({ fields: { uid: { stringValue: aPlay } } }) })).status).toBe(200)

  // Chat callables by Play ID.
  await callAs(a.uid, 'recordVibeRating', { matchId: back.matchId, otherUid: bPlay, rating: 'loving_it' })
  const after = await rest(b.uid, `playMatches/${back.matchId}`)
  expect(after.text).toContain(`lastVibeRating_${aPlay}`)
  expectNoUid(after.text, [a.uid, b.uid], 'playMatches doc after a vibe rating')
  expectNoUid(JSON.stringify(await callAs(a.uid, 'getPastConnections', { mode: 'play' })), others, 'getPastConnections')
  const distances = await callAs(a.uid, 'getDistances', { uids: [bPlay] })
  expect(Object.keys(distances.distances)).toEqual([bPlay])

  // The public Play profile: no uid, no Spark details.
  const prof = await rest(a.uid, `playProfiles/${bPlay}`)
  expect(prof.status).toBe(200)
  expect(prof.text).toContain('Velvet')
  expectNoUid(prof.text, [b.uid], 'playProfiles')
  expect(prof.text).not.toMatch(/Bella|Austin/)

  // Server-only: the mapping, a match's members, the owner's Play profile,
  // blocks, the pair's Play records — none readable by a client.
  for (const path of [`playIds/${b.uid}`, `playIdOwners/${bPlay}`, `playMatchMembers/${back.matchId}`, `users/${b.uid}/playProfile/data`, `users/${a.uid}/blockedUsers/${b.uid}`, `pairs/${sortedPair(a.uid, b.uid)}/modes/play`, `playPairs/${[aPlay, bPlay].sort().join('_')}`, `playReveals/${a.uid}/by/${b.uid}`]) {
    expect((await rest(a.uid, path)).status, path).toBe(403)
  }
  // Your own Play ID is yours to read (private/account).
  expect((await rest(a.uid, `users/${a.uid}/private/account`)).text).toContain(aPlay)
  // A Spark-only user can't read Play profiles or Play matches.
  expect((await rest(spark.uid, `playProfiles/${bPlay}`)).status).toBe(403)
  expect((await rest(spark.uid, `playMatches/${back.matchId}`)).status).toBe(403)

  // Reporting and blocking from Play: by Play ID, mapped back server-side.
  await callAs(a.uid, 'submitReport', { matchId: back.matchId, reportedUid: bPlay, categories: ['scam'] })
  const report = (await db.collection('reports').where('reporterUid', '==', a.uid).get()).docs[0]?.data()
  expect(report).toMatchObject({ reportedUid: b.uid, matchId: back.matchId, reportedSnapshot: { name: 'Velvet', mode: 'play' } })
  await callAs(a.uid, 'blockUser', { targetUid: bPlay, matchId: back.matchId })
  expect((await db.doc(`playMatches/${back.matchId}`).get()).data()).toMatchObject({ isBlocked: true, blockedBy: aPlay })
  expect((await db.doc(`users/${a.uid}/blockedUsers/${b.uid}`).get()).data()).toMatchObject({ blockedBy: a.uid, mode: 'play' })
  const blocked = await callAs(a.uid, 'getBlockedUsers', { mode: 'play' })
  expect(blocked.blocked).toEqual([expect.objectContaining({ playId: bPlay, name: 'Velvet' })])
  expectNoUid(JSON.stringify(blocked), others, 'getBlockedUsers')
  await callAs(a.uid, 'unblockMember', { targetUid: bPlay })
  expect((await db.doc(`users/${a.uid}/blockedUsers/${b.uid}`).get()).exists).toBe(false)
})

test('a Spark match and a Play match side by side; unmatching one leaves the other', async () => {
  const { a, b } = await seedPlayers()
  await likeAs(a.uid, b.uid, 'spark')
  expect((await likeAs(b.uid, a.uid, 'spark')).matched).toBe(true)
  await likeAs(a.uid, b.uid, 'play')
  const r = await likeAs(b.uid, a.uid, 'play')
  expect(r.matched).toBe(true)
  expect(r.matchId).toMatch(/^pm_/)
  expect((await db.doc(`matches/${sortedPair(a.uid, b.uid)}`).get()).data()?.mode).toBe('spark')
  await callAs(a.uid, 'unmatchConnection', { matchId: r.matchId })
  await expect.poll(async () => (await db.doc(`playMatches/${r.matchId}`).get()).exists, { timeout: 20000 }).toBe(false)
  await expect.poll(async () => (await db.doc(`playMatchMembers/${r.matchId}`).get()).exists, { timeout: 20000 }).toBe(false)
  expect(await playMatchOf(a.uid, b.uid)).toBeNull()
  expect((await db.doc(`matches/${sortedPair(a.uid, b.uid)}`).get()).exists).toBe(true)
})

test('in the app: Play shows Play IDs only, never a uid, and nothing leads to a Spark profile', async ({ browser }) => {
  const { a, b } = await seedPlayers()
  const bPlay = await playIdOf(b.uid)
  await likeAs(b.uid, a.uid, 'play')
  const { matchId } = await likeAs(a.uid, b.uid, 'play')
  expect(matchId).toMatch(/^pm_/)
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  // Everything the app is sent back: callable answers and Firestore reads.
  const bodies = []
  page.on('response', async (res) => {
    const url = res.url()
    if (!/127\.0\.0\.1:(5311|8390)/.test(url)) return
    try {
      bodies.push(`${url}\n${await Promise.race([res.text(), new Promise((r) => setTimeout(() => r(''), 3000))])}`)
    } catch {
      // streaming responses that close early
    }
  })
  await offline(page)
  await quietFirstRun(page, a.uid)
  await page.addInitScript((m) => localStorage.setItem(`zylove_chat_seen_${m}`, '1'), matchId)
  await signIn(page, a.phone, { expectPath: /\/discover/ })
  await page.goto(`/chat/${matchId}`)
  // A Play chat opened directly asks for the Play PIN first (Stage B PlayGate).
  await expect(page.getByText('Create your Play PIN')).toBeVisible({ timeout: 20000 })
  await page.keyboard.type('2468')
  await expect(page.getByText('Confirm your PIN')).toBeVisible()
  await page.keyboard.type('2468')
  await expect(page.getByText('Velvet').first()).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('Bella')).toHaveCount(0)
  // The chat header leads to the Play profile, by Play ID — not the Spark one.
  await page.getByRole('button', { name: /Velvet/ }).first().click()
  await expect(page).toHaveURL(new RegExp(`/profile/${bPlay}$`))
  await expect(page.getByText('Velvet').first()).toBeVisible({ timeout: 20000 })
  await expect(page.getByText(/Bella/)).toHaveCount(0)
  // Chats list.
  await page.goto('/matches')
  await expect(page.getByText('Velvet').first()).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(1500)

  const shown = [page.url(), await page.content(), JSON.stringify(await page.evaluate(() => ({ ...localStorage }))), ...bodies].join('\n')
  expectNoUid(shown, [b.uid], 'what the app was sent or shows')
  // A uid in a Play URL shows nothing of the Spark profile.
  await page.goto(`/profile/${b.uid}`)
  await expect(page.getByText(/isn't available|doesn't have a Play profile/)).toBeVisible({ timeout: 20000 })
  await expect(page.getByText(/Bella/)).toHaveCount(0)
  await ctx.close()
})

test('migration: Play IDs, Play photos moved off the uid, public Play profiles; Play matches, likes and reveals reset; idempotent', async () => {
  const { a, b } = await seedPlayers()
  const c = await seedUser('Kai', {}, { play: PLAY('Kai') })
  // State from before F-062: a Play photo under the uid, a uid-pair Play match
  // with a message, Play likes and a reveal on the pair doc.
  const bucket = getStorage().bucket(BUCKET)
  const old = `photos/${a.uid}/play/old-1.jpg`
  await bucket.file(old).save(Buffer.from('jpeg'), { contentType: 'image/jpeg', metadata: { metadata: { zyloveCopy: '1' } } })
  await db.doc(`users/${a.uid}/playProfile/data`).update({ photoURLs: [old, PHOTO] })
  await db.doc(`users/${a.uid}/private/account`).set({ pendingPhotoURLs: [{ url: `photos/${a.uid}/play/old-2.jpg`, mode: 'play' }] }, { merge: true })
  await bucket.file(`photos/${a.uid}/play/old-2.jpg`).save(Buffer.from('jpeg2'), { contentType: 'image/jpeg', metadata: { metadata: { zyloveCopy: '1' } } })
  const pid = sortedPair(a.uid, b.uid)
  await db.doc(`matches/${pid}`).set({ users: [a.uid, b.uid].sort(), mode: 'play', matchedAt: new Date() })
  await db.collection(`matches/${pid}/messages`).add({ senderId: a.uid, ciphertext: 'x', nonce: 'n', sentAt: new Date() })
  await db.doc(`users/${a.uid}/matches/${pid}`).set({ matchId: pid, otherUid: b.uid, mode: 'play' })
  await db.doc(`users/${b.uid}/likeQueue/${a.uid}`).set({ likerUid: a.uid, mode: 'play', likedAt: Date.now() })
  await db.doc(`users/${a.uid}/likeQueue/${b.uid}`).set({ likerUid: b.uid, mode: 'spark', likedAt: Date.now() })
  await db.doc(`pairs/${pid}`).set({ userA: [a.uid, b.uid].sort()[0], userB: [a.uid, b.uid].sort()[1], [`${b.uid}_revealed_play`]: true, [`${b.uid}_revealed_spark`]: true })
  await db.doc(`pairs/${pid}/likes/play`).set({ likedBy: [a.uid] })
  await db.doc(`pairs/${pid}/likes/spark`).set({ likedBy: [b.uid] })

  const plan = await planF062({ db })
  const s = summary(plan)
  expect(s['Play profiles (accounts to get a Play ID)']).toBe(3)
  expect(s['Play photos to copy to playPhotos/{playId}/']).toBe(2)
  expect(s['Play matches to delete']).toBe(1)
  expect(s['  their messages']).toBe(1)
  expect(s['Play likes in like queues to delete']).toBe(1)
  expect(s['pairs/*/likes/play to delete']).toBe(1)
  expect(s['pair docs with Play reveals to clear']).toBe(1)

  const { ensurePlayId } = fnLib('playIds')
  const { refreshPlayProfile } = fnLib('playProfiles')
  await applyF062({ db, bucket, FieldValue, ensurePlayId, refreshPlayProfile }, plan)

  const aPlay = await playIdOf(a.uid)
  const moved = `playPhotos/${aPlay}/old-1.jpg`
  expect((await bucket.file(moved).exists())[0]).toBe(true)
  expect((await bucket.file(old).exists())[0]).toBe(true) // the old file is kept (backup)
  expect((await db.doc(`users/${a.uid}/playProfile/data`).get()).get('photoURLs')).toEqual([moved, PHOTO])
  expect((await db.doc(`users/${a.uid}/private/account`).get()).get('pendingPhotoURLs')[0].url).toBe(`playPhotos/${aPlay}/old-2.jpg`)
  const pub = (await db.doc(`playProfiles/${aPlay}`).get()).data()
  expect(pub).toMatchObject({ playDisplayName: 'Ember', photoURLs: [moved, PHOTO], age: 30 })
  expect(JSON.stringify(pub)).not.toContain(a.uid)
  for (const u of [b.uid, c.uid]) expect((await db.doc(`playIds/${u}`).get()).exists).toBe(true)
  expect((await db.doc(`matches/${pid}`).get()).exists).toBe(false)
  expect((await db.collection(`matches/${pid}/messages`).get()).size).toBe(0)
  expect((await db.doc(`users/${a.uid}/matches/${pid}`).get()).exists).toBe(false)
  expect((await db.doc(`users/${b.uid}/likeQueue/${a.uid}`).get()).exists).toBe(false)
  expect((await db.doc(`users/${a.uid}/likeQueue/${b.uid}`).get()).exists).toBe(true) // Spark likes stay
  expect((await db.doc(`pairs/${pid}/likes/play`).get()).exists).toBe(false)
  expect((await db.doc(`pairs/${pid}/likes/spark`).get()).exists).toBe(true)
  const pair = (await db.doc(`pairs/${pid}`).get()).data()
  expect(pair[`${b.uid}_revealed_play`]).toBeUndefined()
  expect(pair[`${b.uid}_revealed_spark`]).toBe(true)

  // Again: nothing left to move or reset (and the Play IDs don't change).
  const again = summary(await planF062({ db }))
  expect(again['Play photos to copy to playPhotos/{playId}/']).toBe(0)
  expect(again['Play matches to delete']).toBe(0)
  expect(again['Play likes in like queues to delete']).toBe(0)
  expect(again['pairs/*/likes/play to delete']).toBe(0)
  expect(again['pair docs with Play reveals to clear']).toBe(0)
  await applyF062({ db, bucket, FieldValue, ensurePlayId, refreshPlayProfile }, await planF062({ db }))
  expect(await playIdOf(a.uid)).toBe(aPlay)
})

// ─── On the devices ──────────────────────────────────────────────────────────

async function device(browser, user, matchId) {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, user.uid)
  await page.addInitScript((m) => localStorage.setItem(`zylove_chat_seen_${m}`, '1'), matchId)
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page, net }
}
async function openPlayChat(page, matchId) {
  await page.goto(`/chat/${matchId}`)
  await expect(page.getByText('Create your Play PIN')).toBeVisible({ timeout: 20000 })
  await page.keyboard.type('2468')
  await expect(page.getByText('Confirm your PIN')).toBeVisible()
  await page.keyboard.type('2468')
}
async function send(page, partner, text) {
  const box = page.getByPlaceholder(`Message ${partner}…`)
  await expect(box).toBeVisible({ timeout: 20000 })
  await box.fill(text)
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 20000 })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

test('a Play chat on two devices: end-to-end encrypted with the Play keys (not the Spark key), franked by Play ID; a report with evidence verifies', async ({ browser }) => {
  const { a, b } = await seedPlayers()
  const [aPlay, bPlay] = [await playIdOf(a.uid), await playIdOf(b.uid)]
  await likeAs(a.uid, b.uid, 'play')
  const { matchId } = await likeAs(b.uid, a.uid, 'play')
  const A = await device(browser, a, matchId)
  const B = await device(browser, b, matchId)
  // Each device publishes its Play key on the public Play profile — a
  // different key from the account's (Spark) one.
  for (const [u, p] of [[a, aPlay], [b, bPlay]]) {
    await expect.poll(async () => (await db.doc(`playProfiles/${p}`).get()).data()?.publicPlayKey?.length ?? 0, { timeout: 30000 }).toBeGreaterThan(20)
    const spark = (await db.doc(`users/${u.uid}`).get()).data()?.publicKey
    expect(spark?.length ?? 0).toBeGreaterThan(20)
    expect((await db.doc(`playProfiles/${p}`).get()).data().publicPlayKey).not.toBe(spark)
  }

  await openPlayChat(B.page, matchId)
  for (const t of ['hey Ember', 'can you send me money through cash app']) await send(B.page, 'Ember', t)
  await expect.poll(async () => (await db.collection(`playMatches/${matchId}/messages`).get()).size, { timeout: 20000 }).toBe(2)
  const msgs = (await db.collection(`playMatches/${matchId}/messages`).orderBy('sentAt').get()).docs
  for (const d of msgs) {
    expect(d.data()).toMatchObject({ senderId: bPlay, fc: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(d.data().ciphertext).not.toContain('Ember') // encrypted
    await expect.poll(async () => (await db.doc(`franking/${matchId}_${d.id}`).get()).data()?.sender, { timeout: 30000 }).toBe(bPlay)
  }

  // Ember reads them (decrypted with the Play keys) and reports with evidence.
  await openPlayChat(A.page, matchId)
  await expect(A.page.getByText('can you send me money through cash app')).toBeVisible({ timeout: 20000 })
  await send(A.page, 'Velvet', 'no thanks')
  await expect(B.page.getByText('no thanks')).toBeVisible({ timeout: 20000 })
  await A.page.getByRole('button', { name: 'More options' }).click()
  await A.page.getByRole('button', { name: 'Report Velvet' }).click()
  await A.page.getByRole('button', { name: /Scam or asked for money/ }).click()
  await A.page.getByRole('button', { name: 'Add evidence (choose messages)' }).click()
  await A.page.getByRole('checkbox', { name: 'Velvet: can you send me money through cash app' }).check()
  await A.page.getByRole('button', { name: /^Review/ }).click()
  await A.page.getByRole('button', { name: 'Send report with 1 message' }).click()
  await expect(A.page.getByText(/Report sent/)).toBeVisible({ timeout: 20000 })
  const locker = (await db.collection('evidenceLocker').get()).docs[0].data()
  expect(locker).toMatchObject({ reporterUid: a.uid, reportedUid: b.uid, matchId, mode: 'play', summary: { items: 1, verified: 1, mismatch: 0 } })

  const seen = [A.page.url(), await A.page.content(), JSON.stringify(await A.page.evaluate(() => ({ ...localStorage })))].join('\n')
  expectNoUid(seen, [b.uid], "Ember's page")
  for (const d of [A, B]) {
    expect(d.net.errors).toEqual([])
    await d.ctx.close()
  }
})

test('a curated profile in Play: its like-back and replies are by Play ID too', async () => {
  require('../stub-anthropic.cjs') // this process runs processBotLikeBacks directly
  const { a } = await seedPlayers()
  const bot = 'zbot-e2e-play-1'
  await db.doc(`users/${bot}`).set({
    uid: bot, displayName: 'Ivy', age: 29, genderIdentity: 'woman', attractedTo: ['men'], isBot: true, photoURLs: [PHOTO],
    sparkVisibility: 'active', onboardingComplete: true, isSuspended: false, locationLat: 30.27, locationLng: -97.74, sortKey: Math.random(),
  })
  await db.doc(`users/${bot}/playProfile/data`).set({ playDisplayName: 'Ivy After Dark', playBio: 'bot play bio', photoURLs: [PHOTO], playOnboardingComplete: true })
  await fnLib('playProfiles').refreshPlayProfile(bot)
  const botPlay = await playIdOf(bot)
  expect((await db.doc(`playProfiles/${botPlay}`).get()).data()).toMatchObject({ curated: true, playDisplayName: 'Ivy After Dark' })

  await likeAs(a.uid, bot, 'play')
  const aPlay = await playIdOf(a.uid)
  expect((await db.doc(`users/${bot}/likeQueue/${aPlay}`).get()).exists).toBe(true)
  const pendingRef = db.doc(`pendingBotLikes/${bot}_${a.uid}`)
  await expect.poll(async () => (await pendingRef.get()).exists, { timeout: 20000 }).toBe(true)
  await pendingRef.update({ dueAt: (await import('./helpers.mjs')).Timestamp.fromMillis(Date.now() - 1000) })
  await fnLib('botLikeBack').processBotLikeBacks.run({})
  const matchId = await playMatchOf(a.uid, bot)
  expect(matchId).toMatch(/^pm_/)
  const match = (await db.doc(`playMatches/${matchId}`).get()).data()
  expect(match).toMatchObject({ isBot: true, botPlayer: botPlay, players: [aPlay, botPlay].sort() })
  expectNoUid(JSON.stringify(match), [a.uid, bot], 'bot playMatches doc')
  await expect.poll(async () => (await db.collection(`playMatches/${matchId}/messages`).where('senderId', '==', botPlay).get()).size, { timeout: 20000 }).toBeGreaterThan(0)

  // A plaintext message to a curated profile (allowed: isBot), and its reply.
  const status = (await fetch(`${BASE}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await idTokenFor(a.uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [{
      update: { name: `projects/${PROJECT}/databases/(default)/documents/playMatches/${matchId}/messages/hello1`, fields: { senderId: { stringValue: aPlay }, ciphertext: { stringValue: 'hey Ivy' }, nonce: { stringValue: 'stub' }, messageType: { stringValue: 'text' }, status: { stringValue: 'sent' } } },
      updateTransforms: [{ fieldPath: 'sentAt', setToServerValue: 'REQUEST_TIME' }],
    }] }),
  })).status
  expect(status).toBe(200)
  await expect.poll(async () => (await db.collection(`playMatches/${matchId}/messages`).where('senderId', '==', botPlay).get()).size, { timeout: 30000 }).toBeGreaterThan(1)
  expectNoUid(JSON.stringify((await db.collection(`playMatches/${matchId}/messages`).get()).docs.map((d) => d.data())), [a.uid, bot], 'bot chat messages')
})

test('chat photos in Play: named for your Play ID (never the uid), readable only by the two players, after consent', async () => {
  const { a, b } = await seedPlayers()
  const stranger = await seedUser('Cal')
  const aPlay = await playIdOf(a.uid)
  await likeAs(a.uid, b.uid, 'play')
  const { matchId } = await likeAs(b.uid, a.uid, 'play')
  const upload = async (uid, name) => {
    const path = `chat-photos/${matchId}/${name}`
    const boundary = 'b' + Math.random().toString(36).slice(2)
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ name: path, contentType: 'image/x-zylove-encrypted' })}\r\n--${boundary}\r\nContent-Type: image/x-zylove-encrypted\r\n\r\n`),
      Buffer.from('sealed'),
      Buffer.from(`\r\n--${boundary}--`),
    ])
    return (await fetch(`http://127.0.0.1:9909/v0/b/${BUCKET}/o?name=${encodeURIComponent(path)}`, {
      method: 'POST', headers: { Authorization: `Firebase ${await idTokenFor(uid)}`, 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    })).status
  }
  const read = async (uid, name) =>
    (await fetch(`http://127.0.0.1:9909/v0/b/${BUCKET}/o/${encodeURIComponent(`chat-photos/${matchId}/${name}`)}?alt=media`, { headers: { Authorization: `Firebase ${await idTokenFor(uid)}` } })).status
  expect(await upload(a.uid, `${aPlay}_1.bin`)).toBe(403) // no consent yet
  await db.doc(`playMatches/${matchId}`).update({ photoConsent: { status: 'accepted', requestedBy: aPlay } })
  expect(await upload(a.uid, `${a.uid}_1.bin`)).toBe(403) // the uid: refused
  expect(await upload(a.uid, `${aPlay}_1.bin`)).toBe(200)
  expect(await read(b.uid, `${aPlay}_1.bin`)).toBe(200)
  expect(await read(stranger.uid, `${aPlay}_1.bin`)).toBe(403)
  // Without Play access (lapsed), not even a player can read it.
  await db.doc(`userInternal/${b.uid}`).set({ playAccess: true, playAccessUntil: (await import('./helpers.mjs')).Timestamp.fromMillis(Date.now() - 1000) }, { merge: true })
  expect(await read(b.uid, `${aPlay}_1.bin`)).toBe(403)
})

// ─── Admin: the trust dashboard lists Spark and Play matches ─────────────────

test('trust dashboard: an admin sees an account\'s Spark and Play matches (Play labelled, partner\'s real account + Play name); non-admins are refused', async ({ browser }) => {
  const { a, b } = await seedPlayers()
  const c = await seedUser('Cleo', { genderIdentity: 'woman', attractedTo: ['men'] })
  const admin = await seedUser('Kim', { isAdmin: true })
  await likeAs(a.uid, c.uid)
  expect((await likeAs(c.uid, a.uid)).matched).toBe(true) // Spark
  await likeAs(a.uid, b.uid, 'play')
  const { matchId } = await likeAs(b.uid, a.uid, 'play') // Play
  await callAs(a.uid, 'blockUser', { targetUid: await playIdOf(b.uid), matchId })

  const d = await callAs(admin.uid, 'adminTrustDetail', { uid: a.uid })
  expect(d.matches).toHaveLength(2)
  expect(d.matches.find((m) => m.mode === 'spark')).toMatchObject({ otherUid: c.uid, otherName: 'Cleo', otherPlayName: null, status: 'active' })
  expect(d.matches.find((m) => m.mode === 'play')).toMatchObject({ matchId, otherUid: b.uid, otherName: 'Bella', otherPlayName: 'Velvet', status: 'blocked' })
  // Logged as the trust-detail view it's part of.
  const audit = (await db.collection('adminAudit').where('action', '==', 'trust.detail').get()).docs.map((x) => x.data())
  expect(audit.some((x) => x.actor === admin.uid && x.target === a.uid)).toBe(true)
  // Admin-only.
  await expect(callAs(a.uid, 'adminTrustDetail', { uid: a.uid })).rejects.toThrow(/permission-denied|PERMISSION_DENIED|Admins only/)

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ ...CONTEXT, viewport })
    const page = await ctx.newPage()
    await offline(page)
    await quietFirstRun(page, admin.uid)
    await signIn(page, admin.phone, { expectPath: /\/discover/ })
    const gotIt = page.getByRole('button', { name: 'Got it' })
    await page.goto(`/admin/trust?uid=${a.uid}`)
    if (await gotIt.isVisible({ timeout: 3000 }).catch(() => false)) await gotIt.click()
    const list = page.getByTestId('trust-matches')
    await expect(list).toBeVisible({ timeout: 20000 })
    await expect(list.getByText('Play', { exact: true })).toBeVisible()
    await expect(list.getByText('Spark', { exact: true })).toBeVisible()
    await expect(list.getByText('Play name: Velvet')).toBeVisible()
    await expect(list.getByText('blocked')).toBeVisible()
    // A second browser for the admin: the chat-key notice can cover the page.
    if (await gotIt.isVisible().catch(() => false)) await gotIt.click()
    await expect(gotIt).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/trust-matches-${viewport.width}.png`, fullPage: true })
    if (viewport.width === 1280) {
      // The partner's name opens their own trust detail.
      await list.getByRole('button', { name: 'Bella' }).click()
      await expect(page.getByTestId('trust-matches').getByRole('button', { name: 'Adam' })).toBeVisible({ timeout: 20000 })
    }
    await ctx.close()
  }
})
