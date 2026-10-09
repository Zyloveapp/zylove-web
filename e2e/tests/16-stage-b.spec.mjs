// Stage B (2026-10-07): privacy and abuse fixes from the audit.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, fnLib, sortedPair, signIn, offline, quietFirstRun, CONTEXT, FieldValue, PROJECT, setPlan, playIdOf } from './helpers.mjs'
import { planStageB, applyStageB } from '../../scripts/lib/stageB.mjs'

test.beforeEach(resetEmulators)

const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
const BUCKET = 'demo-zylove.appspot.com'
const auth = async (uid) => ({ Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' })
const restGet = async (uid, path) => (await fetch(`${BASE}/${path}`, { headers: await auth(uid) })).status
const JPEG = readFileSync(new URL('../fixture.jpg', import.meta.url))
const storage = async () => (await import('module')).createRequire(new URL('../web-fn/package.json', import.meta.url).pathname)('firebase-admin/storage').getStorage().bucket(BUCKET)
const PLAY = (n) => ({ playDisplayName: n, playBio: 'b', spiceLevel: 'mild' })
const woman = (name, o = {}, opts) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o }, opts)

async function storageUpload(uid, path, bytes) {
  const boundary = 'b' + Math.random().toString(36).slice(2)
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ name: path, contentType: 'image/jpeg' })}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  return (await fetch(`http://127.0.0.1:9909/v0/b/${BUCKET}/o?name=${encodeURIComponent(path)}`, {
    method: 'POST', headers: { Authorization: `Firebase ${await idTokenFor(uid)}`, 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).status
}

test('Play PIN: server-checked, salted, locks after 5 misses; change needs the current PIN; weak PINs refused; old hash upgrades', async () => {
  const a = await seedUser('Ann')
  expect((await callAs(a.uid, 'getPlayPinStatus')).hasPin).toBe(false)
  await expect(callAs(a.uid, 'setPlayPin', { pin: '1234' })).rejects.toThrow(/too easy/)
  await callAs(a.uid, 'setPlayPin', { pin: '2468' })
  const rec = (await db.doc(`playPins/${a.uid}`).get()).data()
  expect(rec.salt).toBeTruthy()
  expect(rec.hash).not.toContain('2468')
  expect(await restGet(a.uid, `playPins/${a.uid}`)).toBe(403) // nothing for the device to guess against
  expect((await callAs(a.uid, 'checkPlayPin', { pin: '2468' })).result).toBe('ok')
  await expect(callAs(a.uid, 'setPlayPin', { pin: '1357' })).rejects.toThrow() // a change needs the current PIN
  await expect(callAs(a.uid, 'setPlayPin', { pin: '1357', currentPin: '0000' })).rejects.toThrow(/Incorrect/)
  await callAs(a.uid, 'setPlayPin', { pin: '1357', currentPin: '2468' })
  for (let i = 0; i < 4; i++) expect((await callAs(a.uid, 'checkPlayPin', { pin: '9999' })).result).toBe('wrong')
  const fifth = await callAs(a.uid, 'checkPlayPin', { pin: '9999' })
  expect(fifth.result).toBe('locked')
  expect((await callAs(a.uid, 'checkPlayPin', { pin: '1357' })).result).toBe('locked') // even the right one, while locked

  // An old SHA-256 hash in settings/playPin: no longer readable by the owner; upgraded on first correct entry.
  const b = await seedUser('Bob')
  await db.doc(`users/${b.uid}/settings/playPin`).set({ hash: createHash('sha256').update(`${b.uid}:4826`).digest('hex') })
  expect(await restGet(b.uid, `users/${b.uid}/settings/playPin`)).toBe(403)
  expect((await callAs(b.uid, 'getPlayPinStatus')).hasPin).toBe(true)
  expect((await callAs(b.uid, 'checkPlayPin', { pin: '4826' })).result).toBe('ok')
  expect((await db.doc(`users/${b.uid}/settings/playPin`).get()).exists).toBe(false)
  expect((await db.doc(`playPins/${b.uid}`).get()).data().salt).toBeTruthy()
})

test('Play PIN: Play pages reached directly in Spark mode are covered by the PIN; nothing PIN-related in localStorage', async ({ browser }) => {
  const p = await seedUser('Pia', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Pia') })
  await callAs(p.uid, 'setPlayPin', { pin: '2468' })
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, p.uid)
  await signIn(page, p.phone, { expectPath: /\/discover/ })
  await page.goto('/edit-play-profile')
  await expect(page.getByText('🔥 Enter your PIN')).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('Edit Play profile')).toHaveCount(0)
  // Cancel goes to Explore, not the Play page.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page).toHaveURL(/\/discover/)
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('zylove_play_pin')))
  expect(keys).toEqual([])
  await page.goto('/edit-play-profile')
  await page.keyboard.type('2468')
  await expect(page.getByText('🔥 Enter your PIN')).toHaveCount(0, { timeout: 20000 })
  await ctx.close()
})

test('photos: GPS/EXIF stripped on the server before anything else; malformed uploads removed', async () => {
  const a = await seedUser('Ann')
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPSLatitude 30.2672 GPSLongitude -97.7431')])
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload])
  const withGps = Buffer.concat([JPEG.subarray(0, 2), app1, JPEG.subarray(2)])
  const path = `photos/${a.uid}/spark/gps.jpg`
  expect(await storageUpload(a.uid, path, withGps)).toBe(200)
  const file = (await storage()).file(path)
  await expect.poll(async () => (await file.getMetadata())[0].metadata?.zyloveCopy, { timeout: 20000 }).toBe('1')
  const [bytes] = await file.download()
  expect(bytes.includes('GPSLatitude')).toBe(false)
  // Not an image: gone.
  const bad = `photos/${a.uid}/spark/bad.jpg`
  expect(await storageUpload(a.uid, bad, Buffer.from('not an image at all'))).toBe(200)
  await expect.poll(async () => (await (await storage()).file(bad).exists())[0], { timeout: 20000 }).toBe(false)
})

test('photos: more than 30 uploads a day are removed unmoderated', async () => {
  const a = await seedUser('Ann')
  const now = Date.now()
  await db.doc(`rateLimits/${a.uid}`).set({ photoUploads: Array.from({ length: 30 }, () => now) })
  const path = `photos/${a.uid}/spark/over.jpg`
  expect(await storageUpload(a.uid, path, JPEG)).toBe(200)
  await expect.poll(async () => (await (await storage()).file(path).exists())[0], { timeout: 20000 }).toBe(false)
})

test('AI: quota reserved before the call — parallel calls can\'t overrun it', async () => {
  const a = await seedUser('Ann')
  await setPlan(a.uid, 'elite') // Stage C: Elite's Spark AI allowance is 5 a month
  const input = { displayName: 'Ann', age: 30, genderIdentity: 'man', relationshipStatus: 'single', openTo: [], lifestyleTags: [], personalityTraits: [], relationshipValues: [], weekendVibes: [], loveLangGive: [], loveLangReceive: [], promptAnswers: [] }
  const results = await Promise.all(Array.from({ length: 8 }, () => callAs(a.uid, 'generateSparkBio', input).catch(() => ({ bio: '' }))))
  const made = results.filter((r) => r.bio).length
  expect(made).toBe(5)
  // Stage C keeps the count in usage/{uid} (not rateLimits): exactly what was made.
  const month = fnLib('usage').periodKey('month')
  expect((await db.doc(`usage/${a.uid}`).get()).data().sparkBio[month]).toBe(made)
})

test('chat: a person without a chat key gets no plaintext — the send is refused', async ({ browser }) => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  await likeAs(a.uid, b.uid)
  const id = (await likeAs(b.uid, a.uid)).matchId
  await db.doc(`users/${b.uid}`).update({ publicKey: 'stub-public-key' }) // e.g. a broken / legacy key
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, a.uid)
  await page.addInitScript((m) => localStorage.setItem(`zylove_chat_seen_${m}`, '1'), id)
  await signIn(page, a.phone, { expectPath: /\/discover/ })
  await page.goto(`/chat/${id}`)
  const box = page.getByPlaceholder(/Message/)
  await box.fill('hello there')
  // Sending waits for both keys to load; until then Enter does nothing.
  await expect(async () => {
    await box.press('Enter')
    await expect(page.getByText(/hasn't set up encrypted chat yet/)).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 20000 })
  const msgs = await db.collection(`matches/${id}/messages`).where('senderId', '==', a.uid).get()
  expect(msgs.size).toBe(0)
  await ctx.close()
})

test('distances and profile reads: blocks hide the blocker; Play "hidden" only for matches', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  await db.doc(`exploreState/${a.uid}`).set({ spark: { deck: [b.uid] } }, { merge: true })
  expect(Object.keys((await callAs(a.uid, 'getDistances', { uids: [b.uid] })).distances)).toEqual([b.uid])
  await callAs(b.uid, 'blockUser', { targetUid: a.uid })
  expect((await callAs(a.uid, 'getDistances', { uids: [b.uid] })).distances).toEqual({})
  expect(await restGet(a.uid, `users/${b.uid}`)).toBe(403) // the person blocked
  expect(await restGet(a.uid, `users/${b.uid}/sparkProfile/data`)).toBe(403)
  expect(await restGet(b.uid, `users/${a.uid}`)).toBe(200) // the blocker still can (their read-only chat)

  const p1 = await seedUser('Pia', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Pia') })
  const p2 = await woman('Paz', { intent: 'open' }, { play: PLAY('Paz') })
  const p3 = await woman('Pru', { intent: 'open' }, { play: PLAY('Pru') })
  await likeAs(p1.uid, p2.uid, 'play')
  await likeAs(p2.uid, p1.uid, 'play')
  await db.doc(`users/${p2.uid}/playProfile/data`).update({ playVisibility: 'hidden' })
  // F-062: others read the public Play profile, by Play ID.
  const p2Play = await playIdOf(p2.uid)
  await fnLib('playProfiles').refreshPlayProfile(p2.uid)
  expect(await restGet(p1.uid, `playProfiles/${p2Play}`)).toBe(200) // matched
  expect(await restGet(p3.uid, `playProfiles/${p2Play}`)).toBe(403) // not matched
})

test('pairs: no like state on the shared pair doc; sent likes come from the per-mode records', async () => {
  const a = await seedUser('Ann', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ann') })
  const b = await woman('Bea', { intent: 'open' }, { play: PLAY('Bea') })
  // Stage C: Play and the Sent list need a plan — Elite for him; she's
  // Elite by identity once her entitlement is computed.
  await setPlan(a.uid, 'elite')
  await fnLib('playAccess').refreshPlayAccess(b.uid)
  await likeAs(a.uid, b.uid, 'play')
  // F-065: a Play like leaves nothing on (or under) the uid pair; its record
  // is server-only, keyed by the Play IDs.
  expect((await db.doc(`pairs/${sortedPair(a.uid, b.uid)}`).get()).exists).toBe(false)
  const ppd = `playPairData/${[await playIdOf(a.uid), await playIdOf(b.uid)].sort().join('_')}`
  expect((await db.doc(ppd).get()).data().likedBy).toEqual([a.uid])
  expect(await restGet(b.uid, ppd)).toBe(403)
  await callAs(a.uid, 'onTap', { tappedUserId: b.uid })
  const pair = (await db.doc(`pairs/${sortedPair(a.uid, b.uid)}`).get()).data()
  for (const f of ['userALiked', 'userBLiked', 'matched', 'initiatedBy']) expect(pair[f], f).toBeUndefined()
  // F-062: a Play entry is named by Play ID.
  expect((await callAs(a.uid, 'getSentSparks', { mode: 'play' })).sent.map((s) => s.playId)).toEqual([await playIdOf(b.uid)])
  expect((await callAs(a.uid, 'getSentSparks', { mode: 'spark' })).sent).toEqual([])
})

test('suspended accounts are refused by user callables (report/block still work)', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  await db.doc(`userInternal/${a.uid}`).set({ isSuspended: true }, { merge: true })
  for (const [fn, data] of [['getSentSparks', { mode: 'spark' }], ['getDistances', { uids: [b.uid] }], ['onTap', { tappedUserId: b.uid }], ['setLocation', { lat: 30.3, lng: -97.7 }]]) {
    await expect(callAs(a.uid, fn, data), fn).rejects.toThrow(/suspended/i)
  }
  await callAs(a.uid, 'blockUser', { targetUid: b.uid })
})

test('deletion: key backup, PIN, likes in others\' queues, chats and founder thread go', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const c = await woman('Cat')
  await likeAs(a.uid, b.uid)
  const id = (await likeAs(b.uid, a.uid)).matchId
  await likeAs(a.uid, c.uid) // waiting in Cat's queue
  await callAs(a.uid, 'setPlayPin', { pin: '2468' })
  await db.doc(`keyBackups/${a.uid}`).set({ blob: 'x' })
  await db.doc(`founderMessages/${a.uid}/thread/m1`).set({ body: 'hi' })
  await db.doc(`users/${a.uid}/profileReviews/spark/reviews/r1`).set({ x: 1 })
  await fnLib('userData').clearPrivateData(a.uid)
  for (const p of [`keyBackups/${a.uid}`, `playPins/${a.uid}`, `users/${c.uid}/likeQueue/${a.uid}`, `founderMessages/${a.uid}/thread/m1`, `users/${a.uid}/profileReviews/spark/reviews/r1`]) {
    expect((await db.doc(p).get()).exists, p).toBe(false)
  }
  const m = (await db.doc(`matches/${id}`).get()).data()
  expect(m.unmatchedAt).toBeTruthy()
  expect(m.participantSnapshots[a.uid].displayName).toBe('Deleted User')
})

test('migration: Stage B moves likes off pair docs (with their mode) and founder fields off the public doc', async () => {
  const a = await seedUser('Ann', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ann') })
  const b = await woman('Bea', { intent: 'open' }, { play: PLAY('Bea') })
  const pid = sortedPair(a.uid, b.uid)
  const [ua] = pid.split('_')
  // The old layout: flags on the pair, the like's queue entry says Play.
  await db.doc(`pairs/${pid}`).set({ userA: ua, userB: ua === a.uid ? b.uid : a.uid, [ua === a.uid ? 'userALiked' : 'userBLiked']: true, matched: false, initiatedBy: a.uid })
  await db.doc(`users/${b.uid}/likeQueue/${a.uid}`).set({ mode: 'play', likerUid: a.uid })
  await db.doc(`users/${a.uid}`).update({ founderStatus: 'active', founderThreadMeta: { lastMessagePreview: 'secret', hasUnread: true }, founderLastActiveAt: 1 })
  const plan = await planStageB(db)
  await applyStageB({ db, FieldValue }, plan)
  const pair = (await db.doc(`pairs/${pid}`).get()).data()
  for (const f of ['userALiked', 'userBLiked', 'matched', 'initiatedBy']) expect(pair[f], f).toBeUndefined()
  expect((await db.doc(`pairs/${pid}/likes/play`).get()).data().likedBy).toEqual([a.uid])
  const u = (await db.doc(`users/${a.uid}`).get()).data()
  for (const f of ['founderStatus', 'founderThreadMeta', 'founderLastActiveAt']) expect(u[f], f).toBeUndefined()
  expect((await db.doc(`users/${a.uid}/private/account`).get()).data()).toMatchObject({ founderStatus: 'active', founderThreadMeta: { lastMessagePreview: 'secret' } })
  // Idempotent.
  const again = await planStageB(db)
  expect(again.pairs).toEqual([])
  expect(again.users).toEqual([])
})

test('sign-out: every zylove_* key cleared; the chat key forgotten unless "Remember this device"', async ({ browser }) => {
  const a = await seedUser('Ann')
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, a.uid)
  await signIn(page, a.phone, { expectPath: /\/discover/ })
  await page.evaluate(() => localStorage.setItem('zylove_onboarding_draft_play_x', '{"secret":1}'))
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Sign out' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out' })
  // No chat PIN backup: "Remember" starts ticked, with a warning once unticked.
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await dialog.getByRole('checkbox').uncheck()
  await expect(dialog.getByText(/You haven't set a chat PIN/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/, { timeout: 20000 })
  await page.waitForLoadState('load')
  // (the test's own init script re-adds its keybackup snooze and safety-card flag on every load)
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('zylove_') && !k.startsWith('zylove_keybackup_snooze_') && !k.startsWith('zylove_safety_tips_'))).catch(() => null)).toEqual([])
  const keyGone = () => page.evaluate(
    (uid) =>
      new Promise((res) => {
        const r = indexedDB.open('zylove_keys', 1)
        r.onsuccess = () => {
          const t = r.result.transaction('keys', 'readonly').objectStore('keys').get(`zylove_pk_${uid}`)
          t.onsuccess = () => res(!!t.result)
          t.onerror = () => res(false)
        }
        r.onerror = () => res(false)
      }),
    a.uid,
  ).catch(() => null)
  await expect.poll(keyGone).toBe(false)
  await ctx.close()
})
