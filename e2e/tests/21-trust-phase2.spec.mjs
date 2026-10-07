// Trust & Safety Phase 2 (2026-10): anti-scam — bot scam traps, the
// on-device scam banner and code shield, links held back for new accounts,
// "Report scam" auto-suspension pending review, probation, signup country,
// AI-generated / stolen photo flags, "Member since" + reply band, the
// first-match safety card and the sign-in code screen's Resend.
import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, adminAuth, fnLib, sortedPair, signIn, offline, quietFirstRun,
  CONTEXT, internalDoc, userDoc, accountDoc, Timestamp, APP,
} from './helpers.mjs'

test.beforeEach(resetEmulators)

const DAY = 864e5
const BUCKET = 'demo-zylove.appspot.com'
const JPEG = (await import('node:fs')).readFileSync(new URL('../fixture.jpg', import.meta.url))
const woman = (name, o = {}) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o })
async function matchOf(a, b) {
  await likeAs(a.uid, b.uid)
  const r = await likeAs(b.uid, a.uid)
  expect(r.matched).toBe(true)
  return sortedPair(a.uid, b.uid)
}
const adminMessage = (matchId, senderId, extra = {}) =>
  db.collection(`matches/${matchId}/messages`).add({ senderId, messageType: 'text', ciphertext: 'x', nonce: 'n', status: 'sent', sentAt: new Date(), ...extra })
const signals = async (uid) => (await db.doc(`behaviorSignals/${uid}`).get()).data() ?? {}
const flag = async (uid) => (await db.doc(`trustFlags/${uid}`).get()).data()
const setCreated = (uid, ms) => db.doc(`userInternal/${uid}`).set({ accountCreatedAt: ms }, { merge: true })

async function storageUpload(uid, path, bytes, contentType) {
  const boundary = 'b' + Math.random().toString(36).slice(2)
  const meta = JSON.stringify({ name: path, contentType })
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  return (await fetch(`http://127.0.0.1:9909/v0/b/${BUCKET}/o?name=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { Authorization: `Firebase ${await idTokenFor(uid)}`, 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })).status
}

// The Auth record says the account is `daysOld` days old (seedUser's is brand new).
async function ageInAuth(user, daysOld) {
  await adminAuth.deleteUser(user.uid)
  const res = await adminAuth.importUsers([{ uid: user.uid, phoneNumber: user.phone, metadata: { creationTime: new Date(Date.now() - daysOld * DAY).toUTCString(), lastSignInTime: new Date().toUTCString() } }])
  expect(res.failureCount).toBe(0)
}

async function device(browser, user, opts = {}) {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, user.uid, opts)
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page, net }
}
async function send(page, partner, text) {
  const box = page.getByPlaceholder(`Message ${partner}…`)
  await expect(box).toBeVisible({ timeout: 20000 })
  await box.fill(text)
  const btn = page.getByRole('button', { name: 'Send', exact: true })
  await expect(btn).toBeEnabled({ timeout: 20000 })
  await btn.click()
}
async function seedMatch(a, b) {
  const id = sortedPair(a.uid, b.uid)
  await db.doc(`matches/${id}`).set({
    matchId: id, users: [a.uid, b.uid].sort(), participants: [a.uid, b.uid].sort(), mode: 'spark',
    matchedAt: Timestamp.now(), createdAt: Timestamp.now(), matchGeneration: Date.now(), isBlocked: false, safetyCardShown: true,
    participantSnapshots: { [a.uid]: { displayName: a.name, age: 30 }, [b.uid]: { displayName: b.name, age: 30 } },
  })
  return id
}

// ─── Bot scam traps ──────────────────────────────────────────────────────────

test('scam traps: a scam-like message to a curated profile keeps an excerpt and flags the sender', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const bot = 'zbot-e2e-trap'
  const botMatch = sortedPair(a.uid, bot)
  await db.doc(`matches/${botMatch}`).set({ users: [a.uid, bot].sort(), participants: [a.uid, bot].sort(), isBot: true, mode: 'spark', matchedAt: Timestamp.now() })
  await adminMessage(botMatch, a.uid, { ciphertext: 'hey! how was your weekend?', nonce: 'stub' })
  await adminMessage(botMatch, a.uid, { ciphertext: 'Nice to meet you. Can you send me the code you just got? It was sent to you by mistake', nonce: 'stub' })
  // (A fresh emulator can take a while to get to the triggers.)
  await expect.poll(async () => (await db.collection('scamTrapHits').where('uid', '==', a.uid).get()).size, { timeout: 60000 }).toBe(1)
  const hit = (await db.collection('scamTrapHits').where('uid', '==', a.uid).get()).docs[0].data()
  expect(hit.hits).toContain('code')
  expect(hit.excerpt).toMatch(/send me the code/)
  expect(hit.excerpt.length).toBeLessThanOrEqual(200)
  expect(hit.expiresAt.toMillis()).toBeGreaterThan(Date.now() + 89 * DAY)
  await expect.poll(async () => (await flag(a.uid))?.status, { timeout: 20000 }).toBe('open')
  expect((await flag(a.uid)).reasons.map((r) => r.key)).toContain('scam_trap')
  // Between two people the server never reads messages — no trap.
  const human = await matchOf(a, b)
  await adminMessage(human, b.uid, { ciphertext: 'send me money through cash app', nonce: 'n' })
  await new Promise((r) => setTimeout(r, 3000))
  expect((await db.collection('scamTrapHits').where('uid', '==', b.uid).get()).size).toBe(0)
  // Retention: past 90 days the excerpt and the signal go.
  await db.collection('scamTrapHits').doc(`${botMatch}_x`).set({ uid: a.uid, hits: ['code'], excerpt: 'old', expiresAt: Timestamp.fromMillis(Date.now() - 1000) })
  await fnLib('scamTraps').purgeScamTraps.run({})
  expect((await db.doc(`scamTrapHits/${botMatch}_x`).get()).exists).toBe(false)
  expect((await db.collection('scamTrapHits').where('uid', '==', a.uid).get()).size).toBe(1)
})

// ─── Report scam ─────────────────────────────────────────────────────────────

test('report scam: 2 unlinked 48h+ reporters suspend pending review; linked or new reporters don\'t; an admin lifts it', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const t = await woman('Tess')
  const [r1, r2, r3, r4] = await Promise.all(['Rob', 'Ray', 'Rex', 'Roy'].map((n) => seedUser(n)))
  const matches = {}
  for (const r of [r1, r2, r3, r4]) matches[r.uid] = await matchOf(r, t)
  for (const r of [r1, r2, r3]) await setCreated(r.uid, Date.now() - 10 * DAY)
  await setCreated(r4.uid, Date.now() - 3600_000) // an hour old
  // Rex shares Rob's device: they count as one.
  const dev = 'dev_' + 'q'.repeat(20)
  await callAs(r1.uid, 'recordDevice', { deviceId: dev })
  await callAs(r3.uid, 'recordDevice', { deviceId: dev })
  const report = (r) => callAs(r.uid, 'submitReport', { matchId: matches[r.uid], reportedUid: t.uid, categories: ['scam'] })

  await expect(callAs(r1.uid, 'submitReport', { matchId: matches[r1.uid], reportedUid: t.uid, categories: ['made_up'] })).rejects.toThrow(/Unknown report category/)
  await report(r1)
  await report(r3) // linked to Rob
  await report(r4) // too new
  expect((await internalDoc(t.uid)).isSuspended).not.toBe(true)
  await report(r2)
  const n = await internalDoc(t.uid)
  expect(n).toMatchObject({ isSuspended: true, suspendedPendingReview: true, suspendSource: 'auto_scam', suspendedUntil: null })
  expect((await adminAuth.getUser(t.uid)).disabled).toBe(true)
  expect((await flag(t.uid)).status).toBe('open')
  expect((await flag(t.uid)).reasons.map((r) => r.key)).toContain('scam_reports')
  const audits = (await db.collection('adminAudit').where('action', '==', 'trust.auto_suspend').get()).docs.map((d) => d.data())
  expect(audits).toHaveLength(1)
  expect(audits[0]).toMatchObject({ actor: 'system', target: t.uid })
  // The dashboard shows it as pending review; the admin lifts it.
  const detail = await callAs(admin.uid, 'adminTrustDetail', { uid: t.uid })
  expect(detail).toMatchObject({ suspended: true, suspendedPendingReview: true, suspendSource: 'auto_scam' })
  await callAs(admin.uid, 'adminTrustAction', { uid: t.uid, action: 'lift_suspension', reason: 'Reviewed: not a scam' })
  expect((await internalDoc(t.uid)).isSuspended).toBe(false)
  expect((await adminAuth.getUser(t.uid)).disabled).toBe(false)
  expect((await flag(t.uid)).status).toBe('dismissed')
})

// ─── Probation ───────────────────────────────────────────────────────────────

test('probation: off by default; on for a city, new accounts there get 5 likes a day and no chat photos', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const u = await seedUser('Una')
  const v = await woman('Val')
  for (const p of [u, v]) await db.doc(`userLocations/${p.uid}`).set({ lat: 30.25, lng: -97.75, marketCityId: 'austin' }, { merge: true })
  await setCreated(u.uid, Date.now() - DAY) // a day old
  await setCreated(v.uid, Date.now() - 30 * DAY)
  expect((await callAs(u.uid, 'getUsage')).usage.likes.limit).toBe(10)
  await expect(callAs(u.uid, 'adminSetProbation', { cityId: 'austin', enabled: true, reason: 'spam wave' })).rejects.toThrow(/Admins only/)
  await expect(callAs(admin.uid, 'adminSetProbation', { cityId: 'austin', enabled: true })).rejects.toThrow(/reason/)
  await callAs(admin.uid, 'adminSetProbation', { cityId: 'austin', enabled: true, reason: 'spam wave in Austin' })
  expect((await callAs(admin.uid, 'adminGetProbation')).cities.find((c) => c.cityId === 'austin')).toMatchObject({ enabled: true, days: 7, likesPerDay: 5 })
  expect((await callAs(u.uid, 'getUsage')).usage.likes.limit).toBe(5)
  expect((await callAs(v.uid, 'getUsage')).usage.likes.limit).toBe(10) // older account: unaffected

  // Chat photos: Val asks, Una can't accept while on probation.
  const id = await matchOf(u, v)
  await db.doc(`matches/${id}`).update({ photoConsent: { status: 'pending', requestedBy: v.uid } })
  await adminMessage(id, v.uid, { messageType: 'consent_request', ciphertext: 'photo_consent_request', nonce: 'system' })
  await expect(callAs(u.uid, 'acceptPhotoConsent', { matchId: id })).rejects.toThrow(/a little older/)
  await callAs(admin.uid, 'adminSetProbation', { cityId: 'austin', enabled: false, reason: 'wave over' })
  await callAs(u.uid, 'acceptPhotoConsent', { matchId: id })
  expect((await db.doc(`matches/${id}`).get()).data().photoConsent.status).toBe('accepted')
  expect((await db.collection('adminAudit').where('action', 'in', ['probation.on', 'probation.off']).get()).size).toBe(2)
})

// ─── Signup country ──────────────────────────────────────────────────────────

test('signup country: stored once as country codes; a foreign phone in a US city flags for review', async () => {
  const a = await seedUser('Ann')
  const b = await seedUser('Abe')
  for (const p of [a, b]) await db.doc(`userLocations/${p.uid}`).set({ lat: 30.25, lng: -97.75, marketCityId: 'austin' }, { merge: true })
  await adminAuth.updateUser(b.uid, { phoneNumber: '+447700900123' })
  await callAs(a.uid, 'recordDevice', { deviceId: 'dev_' + 'a'.repeat(20) })
  await callAs(b.uid, 'recordDevice', { deviceId: 'dev_' + 'b'.repeat(20) })
  // No GeoLite database in the emulator: the IP country is unknown.
  expect((await internalDoc(a.uid)).countryCheck).toMatchObject({ ip: null, phone: 'US', city: 'US' })
  expect((await internalDoc(b.uid)).countryCheck).toMatchObject({ ip: null, phone: 'GB', city: 'US' })
  expect(JSON.stringify(await internalDoc(b.uid))).not.toContain('127.0.0.1')
  expect((await signals(a.uid)).countryMismatch).toBeUndefined()
  expect((await signals(b.uid)).countryMismatch.text).toBe('phone: GB · city: US')
  await expect.poll(async () => (await flag(b.uid))?.status, { timeout: 20000 }).toBe('open')
  expect((await flag(b.uid)).reasons[0].key).toBe('country_mismatch')
  // Once only.
  await adminAuth.updateUser(a.uid, { phoneNumber: '+33612345678' })
  await callAs(a.uid, 'recordDevice', { deviceId: 'dev_' + 'c'.repeat(20) })
  expect((await internalDoc(a.uid)).countryCheck.phone).toBe('US')
})

// ─── Photo checks ────────────────────────────────────────────────────────────

test('photo checks: AI-generated and stolen photos flag for review; the photos still publish', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Ann')
  const b = await seedUser('Abe')
  const c = await seedUser('Cal')
  const ai = `photos/${a.uid}/spark/e2e-ai-1.jpg`
  const stolen = `photos/${b.uid}/spark/e2e-stolen-1.jpg`
  const clean = `photos/${c.uid}/spark/e2e-clean-1.jpg`
  expect(await storageUpload(a.uid, ai, JPEG, 'image/jpeg')).toBe(200)
  expect(await storageUpload(b.uid, stolen, JPEG, 'image/jpeg')).toBe(200)
  expect(await storageUpload(c.uid, clean, JPEG, 'image/jpeg')).toBe(200)
  // Moderation passes all three (review signals never change that).
  for (const [u, p] of [[a, ai], [b, stolen], [c, clean]]) {
    await expect.poll(async () => (await userDoc(u.uid)).photoURLs?.includes(p), { timeout: 30000 }).toBe(true)
  }
  await expect.poll(async () => (await signals(a.uid)).photoFlags?.ai ?? 0, { timeout: 20000 }).toBe(1)
  await expect.poll(async () => (await signals(b.uid)).photoFlags?.stolen ?? 0, { timeout: 20000 }).toBe(1)
  await expect.poll(async () => (await flag(a.uid))?.reasons?.[0]?.key, { timeout: 20000 }).toBe('ai_photo')
  await expect.poll(async () => (await flag(b.uid))?.reasons?.[0]?.key, { timeout: 20000 }).toBe('stolen_photo')
  await expect.poll(async () => (await db.doc(`photoSignals/${c.uid}`).get()).exists, { timeout: 20000 }).toBe(true)
  expect((await signals(c.uid)).photoFlags).toBeUndefined()
  expect(await flag(c.uid)).toBeUndefined()
  expect((await accountDoc(a.uid))?.pendingPhotoURLs ?? []).toEqual([])
  // The dashboard shows the checks; the Vision budget is counted.
  const detail = await callAs(admin.uid, 'adminTrustDetail', { uid: b.uid })
  expect(detail.photoChecks.find((p) => p.path === stolen).web).toMatchObject({ full: 1, pages: 1, sample: ['https://stock.example/photo-page'] })
  const month = new Date().toISOString().slice(0, 7)
  expect((await db.doc(`rateLimits/_visionWeb_${month}`).get()).data().count).toBe(3)
  // Deleting the account removes the results.
  await fnLib('userData').clearPrivateData(a.uid)
  expect((await db.doc(`photoSignals/${a.uid}`).get()).exists).toBe(false)
})

// ─── Profiles: Member since, reply band, new-account marker ──────────────────

test('profiles: "Member since" and "Usually replies" (5+ conversations) are server-written and shown', async ({ browser }) => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  // The client can't write them.
  for (const field of ['replyBand', 'newUntil']) {
    await expect(
      fetch(`http://127.0.0.1:8390/v1/projects/demo-zylove/databases/(default)/documents/users/${a.uid}?updateMask.fieldPaths=${field}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${await idTokenFor(a.uid)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { [field]: field === 'replyBand' ? { stringValue: 'usually' } : { integerValue: '1' } } }),
      }).then((r) => r.status),
    ).resolves.toBe(403)
  }
  // 5 people wrote first, Bea answered 4 → "usually"; Ann answered 1 of 5 → nothing.
  await db.doc(`behaviorSignals/${b.uid}`).set({ conversationsReceived: 5, repliesGiven: 4 })
  await db.doc(`behaviorSignals/${a.uid}`).set({ conversationsReceived: 5, repliesGiven: 1 })
  await db.doc(`users/${b.uid}`).update({ memberSince: '2026-09' })
  await fnLib('trustScore').computeTrustScores.run({})
  expect((await userDoc(b.uid)).replyBand).toBe('usually')
  expect((await userDoc(a.uid)).replyBand).toBeUndefined()
  // initUserDefaults: a brand-new account's profile says when its first 48h end.
  await callAs(a.uid, 'initUserDefaults')
  const newUntil = (await userDoc(a.uid)).newUntil
  expect(newUntil).toBeGreaterThan(Date.now() + 47 * 3600_000)
  expect(newUntil % 3600_000).toBe(0)

  const { ctx, page } = await device(browser, a)
  await page.goto(`/profile/${b.uid}`)
  await expect(page.getByText('Member since Sep 2026')).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('Usually replies')).toBeVisible()
  await ctx.close()
})

// ─── Chat: on-device banner, code shield, links ──────────────────────────────

test('chat: scam banner + Report (Scam chosen), code shield on both sides, link note from a new account; new accounts can\'t send links', async ({ browser }) => {
  const a = await seedUser('Ada')
  const b = await woman('Bea')
  const c = await seedUser('Cy')
  await ageInAuth(a, 10) // Ada may send links…
  await db.doc(`users/${a.uid}`).update({ newUntil: Date.now() + DAY }) // …but her profile still says "new" (as for a 1-day-old account)
  const id = await seedMatch(a, b)
  const id2 = await seedMatch(c, b)
  const A = await device(browser, a)
  const B = await device(browser, b)
  const C = await device(browser, c)
  for (const u of [a, b, c]) await expect.poll(async () => (await userDoc(u.uid)).publicKey?.length ?? 0, { timeout: 20000 }).toBeGreaterThan(20)

  await A.page.goto(`/chat/${id}`)
  await send(A.page, 'Bea', 'hey Bea! how was your week?')
  await send(A.page, 'Bea', 'can you send me money through cash app')
  await send(A.page, 'Bea', 'what is the 6 digit code they texted you')
  await send(A.page, 'Bea', 'my site is janedoe.com')
  // A bare code waits for a second Send.
  await A.page.getByPlaceholder('Message Bea…').fill('482913')
  await A.page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(A.page.getByText(/This looks like a verification code/)).toBeVisible()
  await A.page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(A.page.getByText('482913')).toBeVisible()
  await expect.poll(async () => (await db.collection(`matches/${id}/messages`).get()).size, { timeout: 20000 }).toBe(5)

  await B.page.goto(`/chat/${id}`)
  await expect(B.page.getByText('can you send me money through cash app')).toBeVisible({ timeout: 20000 })
  const notes = B.page.getByRole('note')
  await expect(notes.filter({ hasText: 'This message mentions money' })).toHaveCount(1)
  await expect(notes.filter({ hasText: 'Never share a verification code' })).toHaveCount(1)
  await expect(notes.filter({ hasText: 'This link came from a brand-new account' })).toHaveCount(1)
  // The ordinary message gets nothing: 3 messages, 4 notes (the code one has two).
  await expect(notes).toHaveCount(4)
  await notes.filter({ hasText: 'This message mentions money' }).getByRole('button', { name: 'Report' }).click()
  await expect(B.page.getByRole('button', { name: /Scam or asked for money/ })).toHaveAttribute('aria-pressed', 'true')

  // Cy's account is brand new: his link stays on his device.
  await C.page.goto(`/chat/${id2}`)
  await send(C.page, 'Bea', 'look at www.example.com')
  await expect(C.page.getByText('Links can be shared once your account is a little older.')).toBeVisible()
  await new Promise((r) => setTimeout(r, 1500))
  expect((await db.collection(`matches/${id2}/messages`).get()).size).toBe(0)
  for (const d of [A, B, C]) {
    expect(d.net.errors).toEqual([])
    await d.ctx.close()
  }
})

// ─── First-match safety card ─────────────────────────────────────────────────

test('safety card: once, at the first match with a real member', async ({ browser }) => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  await matchOf(a, b)
  const { ctx, page } = await device(browser, a, { safetyTips: false })
  await page.goto('/matches')
  const card = page.getByRole('dialog', { name: /A few things before you chat/ })
  await expect(card).toBeVisible({ timeout: 20000 })
  await expect(card.getByText('Never send money')).toBeVisible()
  await card.getByRole('button', { name: 'Got it' }).click()
  await expect(card).toBeHidden()
  await expect.poll(async () => (await db.doc(`users/${a.uid}/private/settings`).get()).data()?.safetyTipsSeenAt ?? 0).toBeGreaterThan(0)
  await ctx.close()
  // Another device: not again (remembered in private settings).
  const second = await device(browser, a, { safetyTips: false })
  await second.page.goto('/matches')
  await expect(second.page.getByText(/Connections|Start a conversation|Links/).first()).toBeVisible({ timeout: 20000 })
  await second.page.waitForTimeout(1500)
  await expect(second.page.getByRole('dialog', { name: /A few things before you chat/ })).toHaveCount(0)
  await second.ctx.close()
})

// ─── Sign-in code screen ─────────────────────────────────────────────────────

test('sign-in: the code screen says where to look and offers Resend', async ({ browser }) => {
  const a = await seedUser('Ann')
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await page.goto(`${APP}/login`)
  await page.getByLabel('Phone number (US)').fill(a.phone.replace(/^\+1/, ''))
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText("Didn't get it? Check Junk / Unknown Senders in Messages, then tap Resend.")).toBeVisible()
  await expect(page.getByRole('button', { name: /Resend code/ })).toBeDisabled()
  // Opens 30 seconds after the code went out.
  await expect(page.getByRole('button', { name: 'Resend code' })).toBeEnabled({ timeout: 40_000 })
  await page.getByRole('button', { name: 'Resend code' }).click()
  await expect(page.getByText('We sent a new code.')).toBeVisible({ timeout: 20000 })
  await ctx.close()
})

// ─── Legal notice names only what changed ────────────────────────────────────

test('legal notice: only the Privacy Policy changed since they last saw it → the title says so', async ({ browser }) => {
  const a = await seedUser('Ann', {}, { legal: { terms: '2026-10-07.2', privacy: '2026-10-07.2' } })
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, a.uid)
  await signIn(page, a.phone, { expectPath: /\/discover/ })
  const notice = page.getByRole('dialog', { name: "We've updated our Privacy Policy" })
  await expect(notice).toBeVisible({ timeout: 20000 })
  await expect(notice.getByText(/the updated Privacy Policy applies/)).toBeVisible()
  await expect(page.getByRole('dialog', { name: /Terms and Privacy/ })).toHaveCount(0)
  await notice.getByRole('button', { name: 'Got it' }).click()
  await expect(notice).toBeHidden()
  await ctx.close()
})
