import { test, expect } from '@playwright/test'
import { createHmac } from 'node:crypto'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, accountDoc, db, callAs, fnLib, PROJECT, APP } from './helpers.mjs'

// A2P 10DLC: versioned SMS consent, STOP/START webhook, consent-gated sends,
// public SMS pages. The webhook's test token comes from e2e/.env.test
// (TWILIO_AUTH_TOKEN; run.sh also writes it to web-fn/.secret.local).
const TOKEN = process.env.TWILIO_AUTH_TOKEN
if (!TOKEN) throw new Error('TWILIO_AUTH_TOKEN missing: copy e2e/.env.test.example to e2e/.env.test')
const SHOTS = new URL('../../shots/', import.meta.url).pathname
const PHONE_CONTEXT = { ...CONTEXT, viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 }
const VERSION = '2026-10-07'

test.beforeEach(resetEmulators)

async function open(browser, user, context = PHONE_CONTEXT) {
  const ctx = await browser.newContext(context)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, user.uid)
  await page.addInitScript((u) => sessionStorage.setItem(`zylove_profile_question_${u}`, '{}'), user.uid)
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page, net }
}

// Posts an inbound text as Twilio would, signed for https://{host}/twilioInbound.
async function inbound(params, { sign = TOKEN } = {}) {
  const host = '127.0.0.1:5311'
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], `https://${host}/twilioInbound`)
  const signature = createHmac('sha1', sign).update(Buffer.from(data, 'utf-8')).digest('base64')
  return fetch(`http://${host}/${PROJECT}/us-central1/twilioInbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    body: new URLSearchParams(params).toString(),
  })
}

const settingsDoc = async (uid) => (await db.doc(`users/${uid}/private/settings`).get()).data() ?? {}

test('sms: opt-in needs the unchecked box ticked; consent stored with version, source and text', async ({ browser }) => {
  const me = await seedUser('Riley')
  const { ctx, page, net } = await open(browser, me)
  await page.goto('/settings')
  await page.getByRole('switch', { name: 'Spark notifications', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Text notifications' })
  await expect(dialog).toBeVisible()
  const box = dialog.getByRole('checkbox')
  await expect(box).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Turn on' })).toBeDisabled()
  await expect(dialog.getByRole('link', { name: 'See SMS Terms.' })).toHaveAttribute('href', '/sms-terms')
  await page.screenshot({ path: `${SHOTS}after-430-optin-modal.png` })
  await box.check()
  await expect(dialog.getByRole('button', { name: 'Turn on' })).toBeEnabled()
  await page.waitForTimeout(400) // the button's opacity transition
  await page.screenshot({ path: `${SHOTS}after-430-optin-modal-checked.png` })
  await dialog.locator('div').first().screenshot({ path: `${SHOTS}sms-opt-in.png` })
  await dialog.getByRole('button', { name: 'Turn on' }).click()
  await expect(dialog).toBeHidden({ timeout: 20000 })
  await expect.poll(async () => (await accountDoc(me.uid))?.smsConsent?.textVersion, { timeout: 20000 }).toBe(VERSION)
  const consent = (await accountDoc(me.uid)).smsConsent
  expect(consent).toMatchObject({ phone: me.phone, source: 'settings', textVersion: VERSION })
  expect(consent.text).toContain('Text me match, message and account notifications from Zylove.')
  expect(consent.grantedAt).toBeTruthy()
  await expect.poll(async () => (await settingsDoc(me.uid)).smsNotificationsEnabled).toEqual({ spark: true, play: false })
  await expect(page.getByRole('switch', { name: 'Spark notifications', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText(/Msg & data rates may apply\. Reply STOP to any text to opt out/)).toBeVisible()
  // The quiet chat nudge is in-app only for now: no SMS toggle.
  await expect(page.getByRole('switch', { name: 'Quiet chat nudge' })).toHaveCount(0)
  await page.getByRole('heading', { name: 'Notifications' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}after-430-settings-notifications.png`, fullPage: true })
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('sms: grantSmsConsent validates version and source; old clients record the legacy text', async () => {
  const me = await seedUser('Sage')
  await expect(callAs(me.uid, 'grantSmsConsent', { textVersion: 'made-up', source: 'settings' })).rejects.toThrow(/invalid-argument|INVALID_ARGUMENT/i)
  await expect(callAs(me.uid, 'grantSmsConsent', { textVersion: VERSION, source: 'sneaky' })).rejects.toThrow(/invalid-argument|INVALID_ARGUMENT/i)
  const r = await callAs(me.uid, 'grantSmsConsent', {})
  expect(r.ok).toBe(true)
  expect((await accountDoc(me.uid)).smsConsent).toMatchObject({ textVersion: 'legacy', source: 'unknown', phone: me.phone })
  await callAs(me.uid, 'grantSmsConsent', { textVersion: VERSION, source: 'onboarding' })
  expect((await accountDoc(me.uid)).smsConsent).toMatchObject({ textVersion: VERSION, source: 'onboarding' })
})

test('sms: sends need a consent record and no opt-out; preferences and quiet hours still apply', async () => {
  const on = { smsNotificationsEnabled: { spark: true, play: false }, smsNotifications: { spark: { newSpark: true, newMessage: false, newMatch: true }, quietNudge: false }, smsQuietHours: { enabled: false } }
  const noConsent = await seedUser('Tatum', on)
  const consented = await seedUser('Uma', { ...on, smsConsent: { grantedAt: new Date(), phone: '' } })
  await db.doc(`users/${consented.uid}/private/account`).set({ smsConsent: { grantedAt: new Date(), phone: consented.phone } }, { merge: true })
  const sms = fnLib('sms')
  expect(await sms.smsTarget(noConsent.uid, 'newSpark', 'spark')).toBeNull()
  expect((await sms.smsTarget(consented.uid, 'newSpark', 'spark'))?.phone).toBe(consented.phone)
  expect(await sms.smsTarget(consented.uid, 'newMessage', 'spark')).toBeNull() // preference off
  expect(await sms.smsTarget(consented.uid, 'newSpark', 'play')).toBeNull() // Play switch off
  expect(await sms.textAccount(noConsent.uid, 'account', 'x')).toBe(false)
  await db.doc(`users/${consented.uid}/private/account`).set({ smsOptOut: { at: new Date() } }, { merge: true })
  expect(await sms.smsTarget(consented.uid, 'newSpark', 'spark')).toBeNull()
})

test('sms: STOP and START through the signed Twilio webhook', async ({ browser }) => {
  const me = await seedUser('Vale', { smsNotificationsEnabled: { spark: true, play: true }, smsNotifications: { spark: { newSpark: true, newMessage: true, newMatch: true } }, smsQuietHours: { enabled: false } })
  await db.doc(`users/${me.uid}/private/account`).set({ smsConsent: { grantedAt: new Date(), phone: me.phone, textVersion: VERSION } }, { merge: true })

  expect((await inbound({ From: me.phone, Body: 'STOP' }, { sign: 'wrong-token' })).status).toBe(403)
  expect((await db.doc(`smsOptOuts/${me.phone}`).get()).exists).toBe(false)

  const stop = await inbound({ From: me.phone, To: '+15125550000', Body: 'Stop', MessageSid: 'SM1' })
  expect(stop.status).toBe(200)
  expect(await stop.text()).toContain('<Response></Response>')
  expect((await db.doc(`smsOptOuts/${me.phone}`).get()).data()).toMatchObject({ source: 'stop' })
  expect((await accountDoc(me.uid)).smsOptOut).toMatchObject({ previousEnabled: { spark: true, play: true } })
  expect((await settingsDoc(me.uid)).smsNotificationsEnabled).toEqual({ spark: false, play: false })
  expect(await fnLib('sms').smsTarget(me.uid, 'newMatch', 'spark')).toBeNull()

  // Settings shows it, and switching on asks for consent again.
  const { ctx, page } = await open(browser, me)
  await page.goto('/settings')
  await expect(page.getByText('You replied STOP, so texts are off. Turn them on to opt back in.')).toBeVisible()
  await page.getByRole('switch', { name: 'Spark notifications', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Text notifications' })).toBeVisible()
  await ctx.close()

  // HELP and anything else change nothing.
  expect((await inbound({ From: me.phone, Body: 'HELP' })).status).toBe(200)
  expect((await db.doc(`smsOptOuts/${me.phone}`).get()).exists).toBe(true)

  // Twilio Advanced Opt-Out: OptOutType wins over the body text.
  expect((await inbound({ From: me.phone, Body: 'unstop please', OptOutType: 'START' })).status).toBe(200)
  expect((await db.doc(`smsOptOuts/${me.phone}`).get()).exists).toBe(false)
  expect((await accountDoc(me.uid)).smsOptOut).toBeUndefined()
  expect((await settingsDoc(me.uid)).smsNotificationsEnabled).toEqual({ spark: true, play: true })
  expect((await fnLib('sms').smsTarget(me.uid, 'newMatch', 'spark'))?.phone).toBe(me.phone)
})

test('sms: public pages — SMS Terms, footer, sign-in consent, contact', async ({ browser }) => {
  const ctx = await browser.newContext(PHONE_CONTEXT)
  const page = await ctx.newPage()
  await page.goto(`${APP}/sms-terms`)
  await expect(page.getByRole('heading', { name: 'SMS Terms', level: 1 })).toBeVisible()
  for (const t of ['Message frequency varies.', 'Message and data rates may apply.', 'Carriers are not liable for delayed or undelivered messages.', 'support@zylove.app']) {
    await expect(page.getByText(t, { exact: false }).first()).toBeVisible()
  }
  await expect(page.getByText('© 2026 Zylove, LLC. All rights reserved.')).toBeVisible()
  await page.goto(`${APP}/`)
  await expect(page.getByText(/By entering your number, you agree to receive a one-time verification code by SMS/)).toBeVisible()
  await expect(page.getByText(/dual-mode dating app for adults 18\+, operated by Zylove, LLC/)).toBeVisible()
  await page.goto(`${APP}/contact`)
  await expect(page.getByText('Zylove, LLC', { exact: true })).toBeVisible()
  await ctx.close()
})

test('legal: existing users see the update notice once; Got it is recorded server-side', async ({ browser }) => {
  const old = await seedUser('Wren', {}, { legal: { terms: '2026-10-05', privacy: '2026-10-05' } })
  const { ctx, page, net } = await open(browser, old)
  const notice = page.getByRole('dialog', { name: "We've updated our Terms and Privacy Policy" })
  await expect(notice).toBeVisible()
  await expect(notice.getByRole('link', { name: 'SMS Terms' })).toHaveAttribute('href', '/sms-terms')
  await page.screenshot({ path: `${SHOTS}after-430-legal-notice.png` })
  await notice.getByRole('button', { name: 'Got it' }).click()
  await expect(notice).toBeHidden()
  const { LEGAL_VERSIONS } = fnLib('legal')
  await expect.poll(async () => (await db.doc(`users/${old.uid}/legalAcceptance/notice`).get()).data()?.termsVersion).toBe(LEGAL_VERSIONS.terms)
  expect((await db.doc(`users/${old.uid}/legalAcceptance/main`).get()).data()?.termsVersion).toBe('2026-10-05') // not an acceptance
  await page.reload()
  await expect(page.getByRole('link', { name: 'Sparks' })).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(notice).toHaveCount(0)
  expect(net.errors).toEqual([])
  await ctx.close()

  // No acceptance on record (accounts from before F-024): shown too.
  const older = await seedUser('Xen', {}, { legal: null })
  const second = await open(browser, older)
  await expect(second.page.getByRole('dialog', { name: "We've updated our Terms and Privacy Policy" })).toBeVisible()
  await second.ctx.close()
})
