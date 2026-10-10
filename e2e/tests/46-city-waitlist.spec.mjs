// Austin-only launch with city lock/unlock and a waitlist (Matthew,
// 2026-10-09). Austin is Founding; every other launch city starts Locked.
// Texts go to the Twilio stub (stub-anthropic.cjs → .cache/sms-sent.jsonl).
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, callAs, likeAs, idTokenFor, db, adminAuth,
  internalDoc, accountDoc, sortedPair, PROJECT, PHOTO, fnLib, Timestamp,
} from './helpers.mjs'

test.beforeEach(resetEmulators)

const AUSTIN = { lat: 30.25, lng: -97.75 }
const DALLAS = { lat: 32.78, lng: -96.8 }
const BOISE = { lat: 43.62, lng: -116.2 } // outside every launch city
const WAITLIST_VERSION = 'waitlist-2026-10-09'
const CONFIRMATION = "Zylove: You'll get account notifications from Zylove. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out."
const ACTIVATED = 'Zylove: Your account is now active. Sign in at zylove.app to finish your profile. Reply STOP to opt out.'

const DOCS = `projects/${PROJECT}/databases/(default)/documents`
const BASE = `http://127.0.0.1:8390/v1/${DOCS}`
const SMS_LOG = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'sms-sent.jsonl')
const textsTo = (phone) => {
  try {
    return readFileSync(SMS_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((t) => t.to === phone)
  } catch {
    return []
  }
}
const errOf = (p) => p.then(() => null, (e) => String(e.message))
const daysOld = (uid, days) => db.doc(`userInternal/${uid}`).set({ accountCreatedAt: Date.now() - days * 864e5 }, { merge: true })

// This spec's own numbers (+1555011xxxx), clear of seedUser's +1555010xxxx.
const ownPhone = (k) => `+1555011${String(1000 + k).slice(-4)}`

// A signed-up account with no profile yet (as after the phone code).
let n = 0
async function newAccount() {
  const phone = ownPhone(++n)
  const { uid } = await adminAuth.createUser({ phoneNumber: phone })
  return { uid, phone }
}

// A client write of a minimal profile, as onboarding's first write would be.
async function createProfileAs(uid) {
  const r = await fetch(`${BASE}/users?documentId=${uid}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { uid: { stringValue: uid }, age: { integerValue: '30' } } }),
  })
  return r.status
}

async function sendAs(uid, matchId) {
  const r = await fetch(`${BASE}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [{
        update: {
          name: `${DOCS}/matches/${matchId}/messages/m${Math.random().toString(36).slice(2)}`,
          fields: { senderId: { stringValue: uid }, status: { stringValue: 'sent' }, messageType: { stringValue: 'text' }, ciphertext: { stringValue: 'aGVsbG8=' }, nonce: { stringValue: 'bm9uY2U=' } },
        },
        currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'sentAt', setToServerValue: 'REQUEST_TIME' }],
      }],
    }),
  })
  return r.status
}

async function device(browser, geo, user) {
  const ctx = await browser.newContext({ ...CONTEXT, geolocation: { latitude: geo.lat, longitude: geo.lng } })
  const page = await ctx.newPage()
  const net = await offline(page)
  if (user) await quietFirstRun(page, user.uid)
  return { ctx, page, net }
}

// ─── Sign-up ─────────────────────────────────────────────────────────────────

test('inside Austin: a new account goes straight on to onboarding; no profile can be written before the location check', async ({ browser }) => {
  const bare = await newAccount()
  expect(await createProfileAs(bare.uid)).toBe(403)

  const phone = ownPhone(951)
  const { ctx, page } = await device(browser, AUSTIN)
  await signIn(page, phone, { expectPath: /\/onboarding/ })
  await expect(page.getByText('Before you join Zylove')).toBeVisible({ timeout: 20000 })
  const uid = (await adminAuth.getUserByPhoneNumber(phone)).uid
  expect((await internalDoc(uid)).admission).toMatchObject({ status: 'admitted', cityId: 'austin' })
  expect((await db.doc(`cityWaitlist/${uid}`).get()).exists).toBe(false)
  await ctx.close()
})

test('outside: waitlisted for the nearest city with no profile; staying on it needs text consent; one confirmation text', async ({ browser }) => {
  const phone = ownPhone(952)
  const { ctx, page } = await device(browser, DALLAS)
  await signIn(page, phone, { expectPath: /\/onboarding/ })
  await expect(page.getByRole('heading', { name: 'We\'re so glad you found us.' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('You\'re on the waitlist for')).toContainText('Zylove is launching in Austin, TX first')
  await expect(page.getByText('Dallas', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'See active cities' }).click()
  await expect(page.getByText('✦ Austin, TX')).toBeVisible()
  const uid = (await adminAuth.getUserByPhoneNumber(phone)).uid
  // No profile docs, no deck, not discoverable — and the rules refuse one.
  expect((await db.doc(`users/${uid}`).get()).exists).toBe(false)
  expect((await db.doc(`exploreIndex/${uid}`).get()).exists).toBe(false)
  expect(await createProfileAs(uid)).toBe(403)
  expect(await errOf(callAs(uid, 'getExploreDeck', { mode: 'spark' }))).toMatch(/Profile not available/)
  expect((await db.doc(`cityWaitlist/${uid}`).get()).data()).toMatchObject({ cityId: 'dallas', admittedAt: null })
  expect((await internalDoc(uid)).admission).toMatchObject({ status: 'waitlisted', cityId: 'dallas' })

  // "Save my spot" without ticking: the pop-up; "Turn on texts" ticks and saves.
  await expect(page.getByRole('checkbox')).not.toBeChecked()
  await page.getByRole('button', { name: 'Save my spot' }).click()
  await expect(page.getByRole('heading', { name: 'We\'d hate to lose your spot' })).toBeVisible()
  await expect(page.getByText('Without text permission we can\'t keep you on the Dallas waitlist')).toBeVisible()
  await page.getByRole('button', { name: 'Turn on texts' }).click()
  await expect(page.getByRole('heading', { name: 'You\'re on the Dallas waitlist.' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('We\'ll text you the moment your account is activated.')).toBeVisible()
  const consent = (await accountDoc(uid)).smsConsent
  expect(consent).toMatchObject({ phone, source: 'waitlist', textVersion: WAITLIST_VERSION })
  expect(consent.text).toBe('Text me account notifications from Zylove, including when my account is activated. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.')
  expect(consent.grantedAt).toBeTruthy()
  // One plain confirmation text (UPDATE 5).
  await expect.poll(() => textsTo(phone).map((t) => t.body), { timeout: 10000 }).toEqual([CONFIRMATION])

  // Founder interest (needs the consent just given).
  await page.getByRole('button', { name: 'I\'m interested' }).click()
  await expect(page.getByText('You\'re #1 in line for a Dallas founding spot. When your account is activated, you\'ll get first dibs.')).toBeVisible()
  expect((await db.doc(`founderInterest/dallas/requests/${uid}`).get()).exists).toBe(true)

  // Signing in again shows where they stand.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'You\'re on the Dallas waitlist.' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('You\'re #1 in line')).toBeVisible()
  await ctx.close()
})

test('no text consent: "Remove me" removes the account and every record with the number', async ({ browser }) => {
  const phone = ownPhone(953)
  const { ctx, page } = await device(browser, DALLAS)
  await signIn(page, phone, { expectPath: /\/onboarding/ })
  const uid = (await adminAuth.getUserByPhoneNumber(phone)).uid
  await page.getByRole('button', { name: 'Save my spot' }).click()
  await page.getByRole('button', { name: 'Remove me' }).click()
  await expect(page.getByRole('heading', { name: 'You\'re off the list.' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('If you change your mind, we\'ll be right here.')).toBeVisible()
  await expect.poll(async () => adminAuth.getUserByPhoneNumber(phone).then(() => 'there', () => 'gone'), { timeout: 20000 }).toBe('gone')
  for (const path of [`cityWaitlist/${uid}`, `userInternal/${uid}`, `users/${uid}/private/account`, `userLocations/${uid}`, `users/${uid}`]) {
    expect((await db.doc(path).get()).exists, path).toBe(false)
  }
  expect(await (await db.collection('deletedAccounts').where('previousUid', '==', uid).get()).size).toBe(0)
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 20000 })
  await ctx.close()
})

test('nightly: a waitlisted account that never answered the text question is removed after 7 days; others stay', async () => {
  const silent = await newAccount()
  const recent = await newAccount()
  const yes = await newAccount()
  for (const a of [silent, recent, yes]) await callAs(a.uid, 'checkArea', DALLAS)
  await callAs(yes.uid, 'grantSmsConsent', { textVersion: WAITLIST_VERSION, source: 'waitlist' })
  const eightDays = Timestamp.fromMillis(Date.now() - 8 * 864e5)
  for (const a of [silent, yes]) await db.doc(`cityWaitlist/${a.uid}`).update({ joinedAt: eightDays })
  expect(await fnLib('waitlist').removeUnanswered()).toBe(1)
  expect(await adminAuth.getUserByPhoneNumber(silent.phone).then(() => 'there', () => 'gone')).toBe('gone')
  for (const path of [`cityWaitlist/${silent.uid}`, `userInternal/${silent.uid}`]) expect((await db.doc(path).get()).exists, path).toBe(false)
  for (const a of [recent, yes]) expect((await db.doc(`cityWaitlist/${a.uid}`).get()).exists).toBe(true)
})

// ─── Unlock / lock ───────────────────────────────────────────────────────────

test('unlock: everyone waiting is admitted and consenters get one plain account notice; their next sign-in shows the activation screen', async ({ browser }) => {
  const yes = await newAccount()
  const no = await newAccount()
  for (const a of [yes, no]) expect((await callAs(a.uid, 'checkArea', DALLAS)).status).toBe('waitlisted')
  expect((await callAs(yes.uid, 'grantSmsConsent', { textVersion: WAITLIST_VERSION, source: 'waitlist' })).confirmation).toBe('sent')
  expect(textsTo(yes.phone).map((t) => t.body)).toEqual([CONFIRMATION])
  // Opting in again the same day: no second confirmation (one a day).
  expect((await callAs(yes.uid, 'grantSmsConsent', { textVersion: WAITLIST_VERSION, source: 'waitlist' })).confirmation).toBe('sent')
  expect(textsTo(yes.phone)).toHaveLength(1)

  const admin = await seedUser('Ada', { isAdmin: true })
  expect(await callAs(admin.uid, 'adminSetCityStatus', { cityId: 'dallas', status: 'founding' })).toMatchObject({ from: 'locked', status: 'founding' })
  await expect.poll(async () => (await db.doc(`cityWaitlist/${yes.uid}`).get()).get('textState'), { timeout: 30000 }).toBe('sent')
  expect((await db.doc(`cityWaitlist/${no.uid}`).get()).get('textState')).toBe('none')
  for (const a of [yes, no]) {
    expect((await db.doc(`cityWaitlist/${a.uid}`).get()).get('admittedAt')).not.toBeNull()
    expect((await internalDoc(a.uid)).admission).toMatchObject({ status: 'admitted', cityId: 'dallas', via: 'unlock' })
    expect((await callAs(a.uid, 'checkArea')).status).toBe('admitted')
  }
  expect(textsTo(yes.phone).map((t) => t.body)).toEqual([CONFIRMATION, ACTIVATED])
  expect(textsTo(no.phone)).toEqual([])
  expect((await db.doc('config/waitlistTexts').get()).get('sentToday')).toBe(1)
  // Admitted: a profile may be created now.
  expect(await createProfileAs(no.uid)).not.toBe(403)

  const stats = await callAs(admin.uid, 'adminCityStats')
  expect(stats.cities.find((c) => c.id === 'dallas')).toMatchObject({ status: 'founding', waitlist: 0 })
  expect(stats.cities.find((c) => c.id === 'houston')).toMatchObject({ status: 'locked' })

  const { ctx, page } = await device(browser, DALLAS)
  await signIn(page, yes.phone, { expectPath: /\/onboarding/ })
  // Unlocked into its founding period: "open" ("live" once it's Live).
  await expect(page.getByRole('heading', { name: 'Dallas is open — and you\'re in.' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('Finish your profile and start connecting today, Zylove style.')).toBeVisible()
  await page.getByRole('button', { name: 'Let\'s go' }).click()
  await expect(page.getByText('Before you join Zylove')).toBeVisible({ timeout: 20000 })
  await ctx.close()
})

test('texts are capped per day (config/waitlistTexts.dailyCap) and can be switched off', async () => {
  const people = [await newAccount(), await newAccount(), await newAccount()]
  for (const p of people) {
    await callAs(p.uid, 'checkArea', DALLAS)
    await callAs(p.uid, 'grantSmsConsent', { textVersion: WAITLIST_VERSION, source: 'waitlist' })
  }
  await db.doc('config/waitlistTexts').set({ dailyCap: 2 })
  const admin = await seedUser('Abi', { isAdmin: true })
  await callAs(admin.uid, 'adminSetCityStatus', { cityId: 'dallas', status: 'founding' })
  await expect.poll(async () => (await db.doc('config/waitlistTexts').get()).get('sentToday'), { timeout: 30000 }).toBe(2)
  const states = await Promise.all(people.map(async (p) => (await db.doc(`cityWaitlist/${p.uid}`).get()).get('textState')))
  expect(states.sort()).toEqual(['pending', 'sent', 'sent']) // the next day's sweep sends the rest
  // Switched off: nothing more goes out, even with room under the cap.
  await db.doc('config/waitlistTexts').set({ enabled: false, dailyCap: 10 }, { merge: true })
  expect(await fnLib('waitlist').sendWaitlistTexts()).toBe(0)
})

test('lock: new sign-ups there are waitlisted; existing members keep their deck, plan and chats', async () => {
  const member = await seedUser('Mia')
  const partner = await seedUser('Noa', { genderIdentity: 'woman', attractedTo: ['men'] })
  await likeAs(member.uid, partner.uid)
  expect((await likeAs(partner.uid, member.uid)).matched).toBe(true)
  await expect.poll(async () => (await internalDoc(member.uid))?.entitlement?.source, { timeout: 20000 }).toBe('prelaunch')

  const admin = await seedUser('Abe', { isAdmin: true })
  await callAs(admin.uid, 'adminSetCityStatus', { cityId: 'austin', status: 'locked' })
  const fresh = await newAccount()
  expect(await callAs(fresh.uid, 'checkArea', AUSTIN)).toMatchObject({ status: 'waitlisted', cityId: 'austin', available: [] })

  const deck = await callAs(member.uid, 'getExploreDeck', { mode: 'spark' })
  expect(deck.notLive).toBeUndefined()
  await new Promise((r) => setTimeout(r, 2000)) // onCityStatusChanged re-computes plans
  expect((await internalDoc(member.uid)).entitlement.source).toBe('prelaunch')
  expect(await sendAs(member.uid, sortedPair(member.uid, partner.uid))).toBe(200)
})

test('admin lock/unlock needs an admin, re-checked on the live account (not just the token)', async () => {
  const user = await seedUser('Uma')
  expect(await errOf(callAs(user.uid, 'adminSetCityStatus', { cityId: 'dallas', status: 'founding' }))).toMatch(/Admins only/)
  const admin = await seedUser('Ari', { isAdmin: true })
  const token = await idTokenFor(admin.uid) // still carries the admin claim
  await adminAuth.setCustomUserClaims(admin.uid, {})
  const r = await fetch(`http://127.0.0.1:5311/${PROJECT}/us-central1/adminSetCityStatus`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data: { cityId: 'dallas', status: 'founding' } }),
  })
  expect(JSON.stringify(await r.json())).toMatch(/Admins only/)
  expect((await db.doc('config/city_dallas').get()).get('status')).toBeUndefined()
})

// ─── Members on the move, founders ───────────────────────────────────────────

test('a traveller outside every open city keeps matches and chats and sees "Zylove isn\'t live here yet"; a founder there still gets a deck', async ({ browser }) => {
  const a = await seedUser('Tess')
  const b = await seedUser('Uri', { genderIdentity: 'woman', attractedTo: ['men'] })
  await likeAs(a.uid, b.uid)
  expect((await likeAs(b.uid, a.uid)).matched).toBe(true)
  await callAs(a.uid, 'setLocation', BOISE)
  expect((await callAs(a.uid, 'getExploreDeck', { mode: 'spark' })).notLive).toBe(true)
  expect(await sendAs(a.uid, sortedPair(a.uid, b.uid))).toBe(200)

  const f = await seedUser('Fox')
  await db.doc(`users/${f.uid}`).update({ isFounder: true, founderCityId: 'austin' })
  await callAs(f.uid, 'setLocation', BOISE)
  expect((await callAs(f.uid, 'getExploreDeck', { mode: 'spark' })).notLive).toBeUndefined()

  const { ctx, page } = await device(browser, BOISE, a)
  await signIn(page, a.phone, { expectPath: /\/discover/ })
  await expect(page.getByRole('heading', { name: 'Zylove isn\'t live here yet' })).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('Your matches and chats are still here.')).toBeVisible()
  await ctx.close()
})

test('founder spots: only while inside a Founding city', async () => {
  const d = await seedUser('Dax')
  await daysOld(d.uid, 2)
  await callAs(d.uid, 'setLocation', DALLAS)
  expect(await callAs(d.uid, 'assignFounderBadge')).toEqual({ eligible: false, reason: 'not_founding' })
  await callAs(d.uid, 'setLocation', AUSTIN)
  expect((await callAs(d.uid, 'assignFounderBadge')).eligible).toBe(true)
})

// ─── Decisions: message pause copy, Zylove AI badge ──────────────────────────

test('a paused sender is told why in the chat', async ({ browser }) => {
  const a = await seedUser('Pia')
  const b = await seedUser('Quin', { genderIdentity: 'woman', attractedTo: ['men'] })
  await likeAs(a.uid, b.uid)
  expect((await likeAs(b.uid, a.uid)).matched).toBe(true)
  const matchId = sortedPair(a.uid, b.uid)
  await db.doc(`matches/${matchId}`).update({ safetyCardShown: true }) // no first-chat card
  const B = await device(browser, AUSTIN, b)
  await signIn(B.page, b.phone, { expectPath: /\/discover/ })
  await expect.poll(async () => (await db.doc(`users/${b.uid}`).get()).get('publicKey')?.length ?? 0, { timeout: 20000 }).toBeGreaterThan(20)
  const A = await device(browser, AUSTIN, a)
  await signIn(A.page, a.phone, { expectPath: /\/discover/ })
  const until = new Date(Date.now() + 60 * 60 * 1000)
  await db.doc(`userInternal/${a.uid}`).set({ messagesMutedUntil: Timestamp.fromDate(until) }, { merge: true })
  await db.doc(`users/${a.uid}/private/account`).set({ messagesMutedUntil: Timestamp.fromDate(until) }, { merge: true })
  await A.page.goto(`/chat/${matchId}`)
  const box = A.page.getByPlaceholder('Message Quin…')
  await expect(box).toBeVisible({ timeout: 20000 })
  await box.fill('hello')
  await A.page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(A.page.getByText('You\'re sending messages very fast — try again in an hour.')).toBeVisible({ timeout: 20000 })
  await A.ctx.close()
  await B.ctx.close()
})

test('AI profiles carry a "Zylove AI" badge on the full profile', async ({ browser }) => {
  const viewer = await seedUser('Vic')
  await db.doc('users/zbot-e2e-46').set({
    uid: 'zbot-e2e-46', displayName: 'Ivy', age: 29, genderIdentity: 'woman', attractedTo: ['men'], intent: 'spark', isBot: true,
    bio: 'Coffee and climbing.', photoURLs: [PHOTO], sparkVisibility: 'active', onboardingComplete: true, isSuspended: false,
    publicKey: 'seed-stub-key', locationLat: 30.27, locationLng: -97.74, locationLabel: 'Austin, TX', ageMin: 21, ageMax: 45, subscriptionTier: 'elite',
  })
  const { ctx, page } = await device(browser, AUSTIN, viewer)
  await signIn(page, viewer.phone, { expectPath: /\/discover/ })
  await page.goto('/profile/zbot-e2e-46')
  await expect(page.getByText('Zylove AI', { exact: true }).first()).toBeVisible({ timeout: 20000 })
  await ctx.close()
})

// ─── Founder interest (UPDATE 3) ─────────────────────────────────────────────

test('founder line: needs text consent; place in line by time, joining twice keeps it', async () => {
  const [w0, w1, w2, w3] = [await newAccount(), await newAccount(), await newAccount(), await newAccount()]
  for (const w of [w0, w1, w2, w3]) await callAs(w.uid, 'checkArea', DALLAS)
  expect(await errOf(callAs(w0.uid, 'joinFounderLine'))).toMatch(/Turn on texts/)
  for (const w of [w1, w2, w3]) await callAs(w.uid, 'grantSmsConsent', { textVersion: WAITLIST_VERSION, source: 'waitlist' })
  expect(await callAs(w1.uid, 'joinFounderLine')).toEqual({ place: 1 })
  expect(await callAs(w2.uid, 'joinFounderLine')).toEqual({ place: 2 })
  expect(await callAs(w3.uid, 'joinFounderLine')).toEqual({ place: 3 })
  expect(await callAs(w1.uid, 'joinFounderLine')).toEqual({ place: 1 })
  expect((await callAs(w2.uid, 'checkArea')).founderLine).toBe(2)
  const admin = await seedUser('Ama', { isAdmin: true })
  expect((await callAs(admin.uid, 'adminCityStats')).cities.find((c) => c.id === 'dallas').founderInterest).toBe(3)
})

test('head start: on unlock the first in line get 72 hours of first dibs — halves still apply; then spots open to everyone; outside the city refused', async () => {
  // Members already through onboarding who were waiting for Dallas (seeded
  // straight onto the waitlist and the line, in this order).
  const m1 = await seedUser('Mo')
  const m3 = await seedUser('Max')
  const wom = await seedUser('Wren', { genderIdentity: 'woman', attractedTo: ['men'] })
  const m2 = await seedUser('Mel')
  const t0 = Date.now() - 10 * 60000
  for (const [i, u] of [m1, m3, wom, m2].entries()) {
    await db.doc(`cityWaitlist/${u.uid}`).set({ uid: u.uid, cityId: 'dallas', joinedAt: Timestamp.now(), admittedAt: null, textState: 'none' })
    await db.doc(`userInternal/${u.uid}`).set({ admission: { status: 'waitlisted', cityId: 'dallas' } }, { merge: true })
    await db.doc(`founderInterest/dallas/requests/${u.uid}`).set({ uid: u.uid, at: Timestamp.fromMillis(t0 + i * 1000) })
    await daysOld(u.uid, 2)
    await callAs(u.uid, 'setLocation', DALLAS)
  }
  // A circle of 1 + 1: the first 2 in line (m1, m3 — both men) get the head start.
  await db.doc('config/city_dallas').set({ founderTarget: 1 }, { merge: true })
  const admin = await seedUser('Ann', { isAdmin: true })
  await callAs(admin.uid, 'adminSetCityStatus', { cityId: 'dallas', status: 'founding' })
  await expect.poll(async () => (await internalDoc(m3.uid))?.founderHeadStart?.cityId, { timeout: 30000 }).toBe('dallas')
  expect((await internalDoc(m1.uid)).founderHeadStart.cityId).toBe('dallas')
  expect((await internalDoc(wom.uid)).founderHeadStart).toBeUndefined()
  const ends = (await db.doc('config/city_dallas').get()).get('founderHeadStartUntil').toMillis()
  expect(Math.abs(ends - (Date.now() + 72 * 3600e3))).toBeLessThan(5 * 60e3)
  expect((await callAs(m1.uid, 'checkArea')).status).toBe('member')

  expect(await callAs(wom.uid, 'assignFounderBadge')).toEqual({ eligible: false, reason: 'head_start' })
  expect((await callAs(m1.uid, 'assignFounderBadge')).eligible).toBe(true)
  // First dibs, not a reservation: the men's half (1) is full.
  expect(await callAs(m3.uid, 'assignFounderBadge')).toEqual({ eligible: false, reason: 'cohort_full' })

  // After 72 hours: open to everyone, first come within each half.
  await db.doc('config/city_dallas').update({ founderHeadStartUntil: Timestamp.fromMillis(Date.now() - 1000) })
  expect((await callAs(wom.uid, 'assignFounderBadge')).eligible).toBe(true)
  // Both halves full: the circle is complete and Dallas goes live.
  expect((await db.doc('config/city_dallas').get()).get('status')).toBe('live')
  expect(await callAs(m2.uid, 'assignFounderBadge')).toEqual({ eligible: false, reason: 'not_founding' })
  // Outside every launch city: refused.
  const away = await seedUser('Ash', { genderIdentity: 'woman', attractedTo: ['men'] })
  await daysOld(away.uid, 2)
  await callAs(away.uid, 'setLocation', BOISE)
  expect(await callAs(away.uid, 'assignFounderBadge')).toEqual({ eligible: false, reason: 'outside_coverage' })
})
