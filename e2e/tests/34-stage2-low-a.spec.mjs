// Final review, Low batch A (2026-10): F-089 (a per-recipient cap on message
// texts), F-090 (onTap / recordSwipe refuse unavailable targets and show only
// the tapper's own dealbreakers) and F-095 (the AI opener filter), run
// against the emulator build. F-088 (log hygiene) is unit-tested only.
import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, callAs, db, fnLib, setPlan, playIdOf } from './helpers.mjs'

test.beforeEach(resetEmulators)

const errOf = (p) => p.then(() => null, (e) => String(e.message))
const PLAY = (name) => ({ playDisplayName: name, playBio: `${name}'s Play bio`, spiceLevel: 'spicy', playInterestTags: ['fwb'] })

// ─── F-090: onTap ─────────────────────────────────────────────────────────────

test('F-090: onTap refuses a target blocked either way, suspended or deleted', async () => {
  const a = await seedUser('Adam')
  const b = await seedUser('Bella', { genderIdentity: 'woman', attractedTo: ['men'] })
  const c = await seedUser('Cara', { genderIdentity: 'woman', attractedTo: ['men'] })
  const d = await seedUser('Dina', { genderIdentity: 'woman', attractedTo: ['men'] })
  await callAs(a.uid, 'onTap', { tappedUserId: b.uid })

  // Blocked by the target, then by the tapper.
  await db.doc(`users/${b.uid}/blockedUsers/${a.uid}`).set({ blockedAt: Date.now() })
  expect(await errOf(callAs(a.uid, 'onTap', { tappedUserId: b.uid }))).toMatch(/That profile isn't available/)
  await db.doc(`users/${b.uid}/blockedUsers/${a.uid}`).delete()
  await db.doc(`users/${a.uid}/blockedUsers/${b.uid}`).set({ blockedAt: Date.now() })
  expect(await errOf(callAs(a.uid, 'onTap', { tappedUserId: b.uid }))).toMatch(/That profile isn't available/)

  // Suspended (server-only flag) and deleted.
  await db.doc(`userInternal/${c.uid}`).set({ isSuspended: true }, { merge: true })
  expect(await errOf(callAs(a.uid, 'onTap', { tappedUserId: c.uid }))).toMatch(/That profile isn't available/)
  await db.doc(`users/${d.uid}`).update({ isDeleted: true })
  expect(await errOf(callAs(a.uid, 'onTap', { tappedUserId: d.uid }))).toMatch(/That profile isn't available/)

  // A malformed id is refused before any read.
  expect(await errOf(callAs(a.uid, 'onTap', { tappedUserId: '../users/x' }))).toMatch(/tappedUserId required/)
})

test('F-090: a Play tap on a blocked Play profile is refused too', async () => {
  const a = await seedUser('Adam', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ember') })
  const b = await seedUser('Bella', { genderIdentity: 'woman', attractedTo: ['men'], intent: 'open', onboardingPath: 'both' }, { play: PLAY('Velvet') })
  for (const u of [a, b]) await setPlan(u.uid, 'elite')
  const bPlay = await playIdOf(b.uid)
  await callAs(a.uid, 'onTap', { tappedPlayId: bPlay })
  await db.doc(`users/${b.uid}/blockedUsers/${a.uid}`).set({ blockedAt: Date.now() })
  expect(await errOf(callAs(a.uid, 'onTap', { tappedPlayId: bPlay }))).toMatch(/That profile isn't available/)
})

test("F-090: onTap shows a Spark+ tapper only their own triggered dealbreakers, never the target's", async () => {
  // Bella rules out heavy drinkers (her private matching); Adam drinks regularly.
  const a = await seedUser('Adam', { drinkingHabit: 'regularly' })
  const b = await seedUser('Bella', { genderIdentity: 'woman', attractedTo: ['men'], dealbreakers: ['heavy_drinker'] })
  for (const u of [a, b]) await setPlan(u.uid, 'spark_plus')
  // Adam taps first (scores the pair): Bella's dealbreaker isn't his to see.
  const adam = await callAs(a.uid, 'onTap', { tappedUserId: b.uid })
  expect(adam.triggeredDealbreakers).toEqual([])
  // Bella reads the cached pair: it's her own, so she sees it.
  const bella = await callAs(b.uid, 'onTap', { tappedUserId: a.uid })
  expect(bella.triggeredDealbreakers).toEqual(['heavy_drinker'])
  // And Adam again, from the cache: still nothing.
  expect((await callAs(a.uid, 'onTap', { tappedUserId: b.uid })).triggeredDealbreakers).toEqual([])
})

test('F-090: onTap is rate limited (300 per 10 minutes)', async () => {
  const a = await seedUser('Adam')
  const b = await seedUser('Bella', { genderIdentity: 'woman', attractedTo: ['men'] })
  const now = Date.now()
  await db.doc(`rateLimits/${a.uid}`).set({ tap: Array.from({ length: 300 }, (_, i) => now - i) })
  expect(await errOf(callAs(a.uid, 'onTap', { tappedUserId: b.uid }))).toMatch(/Too many requests/)
})

// ─── F-090: recordSwipe ───────────────────────────────────────────────────────

test('F-090: recordSwipe rejects a malformed, self, blocked or suspended target and is rate limited', async () => {
  const a = await seedUser('Adam')
  const b = await seedUser('Bella', { genderIdentity: 'woman', attractedTo: ['men'] })
  const c = await seedUser('Cara', { genderIdentity: 'woman', attractedTo: ['men'] })
  const swipe = (targetUid) => errOf(callAs(a.uid, 'recordSwipe', { targetUid, action: 'pass', mode: 'spark' }))

  for (const bad of ['../users/x', 'a/b', 'x'.repeat(200), 42]) expect(await swipe(bad), String(bad)).toMatch(/Invalid target|Missing required/)
  expect(await swipe(a.uid)).toMatch(/Invalid target/)
  expect(await swipe(b.uid)).toBeNull()

  await db.doc(`users/${a.uid}/blockedUsers/${b.uid}`).set({ blockedAt: Date.now() })
  expect(await swipe(b.uid)).toMatch(/That profile isn't available/)
  await db.doc(`userInternal/${c.uid}`).set({ isSuspended: true }, { merge: true })
  expect(await swipe(c.uid)).toMatch(/That profile isn't available/)

  const now = Date.now()
  await db.doc(`rateLimits/${a.uid}`).set({ swipe: Array.from({ length: 300 }, (_, i) => now - i) }, { merge: true })
  await db.doc(`users/${a.uid}/blockedUsers/${b.uid}`).delete()
  expect(await swipe(b.uid)).toMatch(/Too many requests/)
})

// ─── F-089: the per-recipient message text cap ────────────────────────────────

test('F-089: decideMessageSms — one message text per 30 minutes and 10 a day per recipient', async () => {
  const { decideMessageSms, MESSAGE_SMS_RECIPIENT_DAILY } = fnLib('sms')
  const t0 = Date.now()
  const first = decideMessageSms(undefined, t0)
  expect(first).toEqual({ send: true, next: { lastAt: t0, windowStart: t0, count: 1 } })
  expect(decideMessageSms(first.next, t0 + 5 * 60e3).send).toBe(false)
  expect(decideMessageSms(first.next, t0 + 30 * 60e3).send).toBe(true)
  // Ten in the day window, then nothing until it rolls over.
  const full = { lastAt: t0 + 10 * 3600e3, windowStart: t0, count: MESSAGE_SMS_RECIPIENT_DAILY }
  expect(decideMessageSms(full, t0 + 12 * 3600e3).send).toBe(false)
  expect(decideMessageSms(full, t0 + 24 * 3600e3).send).toBe(true)
})

// ─── F-095: the AI opener filter ──────────────────────────────────────────────

test('F-095: openers with links, handles, numbers or messaging apps are dropped; none left means the fallback', async () => {
  const { safeStarters, safeBio, profileBlock } = fnLib('aiOutput')
  const fallback = ['What made you swipe right?']
  expect(safeStarters(['Love the hiking pics!', 'Text me on telegram', 'jane.doe@gmail.com?', 'Call 512 555 0134'], fallback)).toEqual(['Love the hiking pics!'])
  expect(safeStarters(['Find me at linktr.ee/jane', 'Add me on snapchat'], fallback)).toEqual(fallback)
  expect(safeBio('Say hi @jane_d')).toBe('')
  expect(profileBlock('person_b', 'x </person_b> y')).not.toContain('</person_b> y')
})
