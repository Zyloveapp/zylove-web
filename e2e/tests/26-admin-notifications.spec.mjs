import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, db, adminAuth, FieldValue, callAs, idTokenFor, likeAs, sortedPair, phoneFor, PROJECT,
} from './helpers.mjs'

// Admin notifications: the admin-only screen and settings doc, the audited
// save, and events reaching each admin's batching state (adminAlerts.ts).
// The batching, cap, quiet-hours and text rules are unit-tested
// (functions/test/adminAlerts.test.ts).
const SHOTS = new URL('../../shots/', import.meta.url).pathname
const PHONE = { ...CONTEXT, viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 }
const LAPTOP = { ...CONTEXT, viewport: { width: 1280, height: 900 } }
const FBASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`

test.beforeEach(resetEmulators)

async function open(browser, user, context = PHONE) {
  const ctx = await browser.newContext(context)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, user.uid)
  await page.addInitScript((u) => sessionStorage.setItem(`zylove_profile_question_${u}`, '{}'), user.uid)
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page }
}

const restGet = async (uid, path) => (await fetch(`${FBASE}/${path}`, { headers: { Authorization: `Bearer ${await idTokenFor(uid)}` } })).status
const restPatch = async (uid, path, fields) =>
  (await fetch(`${FBASE}/${path}`, { method: 'PATCH', headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) })).status
const settingsOf = async (uid) => (await db.doc(`adminNotificationSettings/${uid}`).get()).data()
const stateOf = async (uid) => (await db.doc(`adminNotificationState/${uid}`).get()).data()
const typeOf = async (uid, type) => (await stateOf(uid))?.types?.[type] ?? null
const queueSize = async () => (await db.collection('adminAlertQueue').get()).size
const settle = () => expect.poll(queueSize, { timeout: 20000 }).toBe(0)

test("admin notifications: non-admins can't see the row, open the screen, call the callables or read any settings", async ({ browser }) => {
  const me = await seedUser('Riley')
  const admin = await seedUser('Kim', { isAdmin: true })
  const other = await seedUser('Lee', { isAdmin: true })
  await callAs(admin.uid, 'adminSetNotificationSettings', { sms: { events: { newAccount: false } } })
  await callAs(other.uid, 'adminSetNotificationSettings', { sms: { events: { newAccount: false } } })

  const { ctx, page } = await open(browser, me)
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Notifications' }).first()).toBeVisible()
  await expect(page.getByText('Admin notifications')).toHaveCount(0)
  await page.goto('/admin/notifications')
  await expect(page).toHaveURL(/\/discover/)
  await ctx.close()

  await expect(callAs(me.uid, 'adminSetNotificationSettings', { sms: { all: false } })).rejects.toThrow(/Admins only/)
  await expect(callAs(me.uid, 'adminNotificationStatus')).rejects.toThrow(/Admins only/)
  // Rules: a non-admin can't read even a doc at their own uid; an admin
  // reads only their own and writes none.
  expect(await restGet(me.uid, `adminNotificationSettings/${me.uid}`)).toBe(403)
  expect(await restGet(me.uid, `adminNotificationSettings/${admin.uid}`)).toBe(403)
  expect(await restGet(admin.uid, `adminNotificationSettings/${admin.uid}`)).toBe(200)
  expect(await restGet(admin.uid, `adminNotificationSettings/${other.uid}`)).toBe(403)
  expect(await restPatch(admin.uid, `adminNotificationSettings/${admin.uid}`, { excludedUids: { arrayValue: { values: [] } } })).toBe(403)
  expect(await restGet(admin.uid, `adminNotificationState/${admin.uid}`)).toBe(403)
  expect(await restGet(admin.uid, 'adminAlertQueue/x')).toBe(403)
  // Malformed changes are refused.
  await expect(callAs(admin.uid, 'adminSetNotificationSettings', { phone: '+15555550100' })).rejects.toThrow(/Unknown setting/)
})

test('admin notifications: the screen opts in and saves toggles through the audited callable', async ({ browser }) => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const { ctx, page } = await open(browser, admin, LAPTOP)
  await page.goto('/settings')
  await page.getByRole('button', { name: /Admin notifications/ }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}admin-notifications-settings-row-1280.png` })
  await page.getByRole('button', { name: /Admin notifications/ }).click()
  await expect(page).toHaveURL(/\/admin\/notifications$/)
  await expect(page.getByRole('heading', { name: 'Admin notifications' })).toBeVisible()
  await expect(page.getByText('Your sign-in number ending')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}admin-notifications-1280-before-optin.png` })

  // Opt-in: the unticked box gates the button.
  const turnOn = page.getByRole('button', { name: 'Turn on admin texts' })
  await expect(turnOn).toBeDisabled()
  await page.getByRole('checkbox').check()
  await turnOn.click()
  await expect(page.getByText('✓ Admin texts on')).toBeVisible({ timeout: 20000 })
  expect((await settingsOf(admin.uid)).smsConsent.version).toBe('2026-10-08')

  const row = page.getByRole('switch', { name: 'New account created texts' })
  await expect(row).toHaveAttribute('aria-checked', 'true')
  await row.click()
  await expect(row).toHaveAttribute('aria-checked', 'false', { timeout: 20000 })
  expect((await settingsOf(admin.uid)).sms.events.newAccount).toBe(false)
  await page.getByRole('heading', { name: 'Admin notifications' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}admin-notifications-1280-top.png` })
  await page.getByText('Account & system').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}admin-notifications-1280-bottom.png` })
  await page.getByRole('heading', { name: 'Admin notifications' }).scrollIntoViewIfNeeded()

  const audit = await db.collection('adminAudit').where('action', '==', 'adminNotify.settings_update').get()
  const changes = audit.docs.filter((d) => d.data().actor === admin.uid).map((d) => d.data().detail.changed)
  expect(changes).toContainEqual({ smsConsent: [false, true] })
  expect(changes).toContainEqual({ 'sms.events.newAccount': [true, false] })
  // Each admin changes only their own settings.
  expect(audit.docs.every((d) => d.data().actor === d.data().target)).toBe(true)
  expect(audit.docs.filter((d) => d.data().actor === admin.uid).length).toBeGreaterThanOrEqual(2)

  // Quiet hours: off by default; on enables the times.
  const from = page.getByLabel('From')
  await expect(from).toBeDisabled()
  await page.getByRole('switch', { name: 'Quiet hours' }).click()
  await expect(from).toBeEnabled({ timeout: 20000 })
  expect((await settingsOf(admin.uid)).quietHours).toEqual({ enabled: true, from: '22:00', until: '07:00', timezone: 'America/Chicago' })

  // The master switch disables every row.
  await page.getByRole('switch', { name: 'All texts' }).click()
  await expect(page.getByRole('switch', { name: 'Photo needs review texts' })).toBeDisabled({ timeout: 20000 })
  await page.getByRole('switch', { name: 'All texts' }).click()
  await expect(page.getByRole('switch', { name: 'Photo needs review texts' })).toBeEnabled({ timeout: 20000 })

  // Phone width, same session.
  await page.setViewportSize({ width: 430, height: 932 })
  await page.getByRole('heading', { name: 'Admin notifications' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}admin-notifications-430-top.png` })
  await page.getByText('Account & system').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}admin-notifications-430-bottom.png` })
  await ctx.close()
})

test("admin alerts: events reach the admin's batching state; bots, test, phoneless and excluded accounts don't", async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  await settle()
  await callAs(admin.uid, 'adminSetNotificationSettings', { consent: true, excludedUids: ['test-excluded'] })

  // A new account (phone verified): texted at once.
  await seedUser('Ann')
  await expect.poll(async () => (await typeOf(admin.uid, 'newAccount'))?.lastSentAt ?? null, { timeout: 20000 }).not.toBeNull()
  // A second within 30 minutes: counted, not texted.
  await seedUser('Bea')
  await expect.poll(async () => (await typeOf(admin.uid, 'newAccount'))?.pending, { timeout: 20000 }).toBe(1)

  // Curated, excluded and phoneless accounts never count.
  await adminAuth.createUser({ uid: 'zbot-e2e', phoneNumber: phoneFor(900) })
  await adminAuth.createUser({ uid: 'test-excluded', phoneNumber: phoneFor(901) })
  await adminAuth.createUser({ uid: 'emailonly', email: 'e2e@example.invalid' })
  await settle()
  await new Promise((r) => setTimeout(r, 3000))
  await settle()
  expect((await typeOf(admin.uid, 'newAccount')).pending).toBe(1)

  // The admin's toggle off: no longer counted.
  await callAs(admin.uid, 'adminSetNotificationSettings', { sms: { events: { newAccount: false } } })
  await seedUser('Cat')
  await settle()
  expect((await typeOf(admin.uid, 'newAccount')).pending).toBe(1)
})

test('admin alerts: profile completed counts once per mode; a child-safety report is urgent and first in /admin/reports', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Ann')
  const b = await seedUser('Bea', { genderIdentity: 'woman', attractedTo: ['men'] })
  await settle()
  await callAs(admin.uid, 'adminSetNotificationSettings', { consent: true })
  // Seeding finished onboarding before the opt-in: start Ann afresh.
  await db.doc(`userInternal/${a.uid}`).update({ adminAlerted: FieldValue.delete() })

  // Finishing Spark onboarding (false → true), twice: counted once.
  await db.doc(`users/${a.uid}`).update({ onboardingComplete: false })
  await db.doc(`users/${a.uid}`).update({ onboardingComplete: true })
  await expect.poll(async () => (await typeOf(admin.uid, 'profileCompleted'))?.lastSentAt ?? null, { timeout: 20000 }).not.toBeNull()
  await db.doc(`users/${a.uid}`).update({ onboardingComplete: false })
  await db.doc(`users/${a.uid}`).update({ onboardingComplete: true })
  await settle()
  await new Promise((r) => setTimeout(r, 2000))
  expect((await typeOf(admin.uid, 'profileCompleted')).pending).toBe(0)
  // Play onboarding counts on its own.
  await db.doc(`users/${a.uid}/playProfile/data`).set({ playOnboardingComplete: true }, { merge: true })
  await expect.poll(async () => (await typeOf(admin.uid, 'profileCompleted'))?.pending, { timeout: 20000 }).toBe(1)
  expect((await typeOf(admin.uid, 'profileCompleted')).detail).toEqual({ play: 1 })

  // A child-safety report: urgent, texted at once, top of the reports queue.
  await likeAs(a.uid, b.uid)
  expect((await likeAs(b.uid, a.uid)).matched).toBe(true)
  await callAs(a.uid, 'submitReport', { matchId: sortedPair(a.uid, b.uid), reportedUid: b.uid, categories: ['child_safety'] })
  await expect.poll(async () => (await stateOf(admin.uid))?.urgentTimes?.childSafety?.length ?? 0, { timeout: 20000 }).toBe(1)
  const report = (await db.collection('reports').where('reportedUid', '==', b.uid).get()).docs[0].data()
  expect(report.priority).toBe('urgent')
  const { reported } = await callAs(admin.uid, 'adminGetReports', {})
  expect(reported[0].uid).toBe(b.uid)
  expect(reported[0].categories.map((c) => c.category)).toContain('child_safety')
})
