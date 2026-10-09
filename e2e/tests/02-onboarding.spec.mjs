import { test, expect } from '@playwright/test'
import { resetEmulators, signIn, offline, CONTEXT, FIXTURE, userDoc, db, adminAuth } from './helpers.mjs'

test.beforeEach(resetEmulators)

// Full Spark onboarding through the UI: every required step, optional steps
// skipped, AI steps allowed to fail soft (no Anthropic key in the emulator),
// one photo uploaded to Storage and routed through onPhotoUpload.
test('onboarding: new user completes Spark onboarding', async ({ browser }) => {
  test.setTimeout(240000)
  const phone = '+15550108888'
  const ctx = await browser.newContext({ ...CONTEXT, geolocation: { latitude: 41.26, longitude: -95.94 } }) // Omaha: no founder invite
  const page = await ctx.newPage()
  const net = await offline(page)
  await signIn(page, phone, { expectPath: /\/onboarding/ })
  const uid = (await adminAuth.getUserByPhoneNumber(phone)).uid

  const next = () => page.getByRole('button', { name: /^(Next|Continue →)$/ }).click()
  const step = (title) => expect(page.getByText(new RegExp(`Step \\d+ of \\d+ · ${title}`))).toBeVisible()

  // 1. Terms
  await expect(page.getByText('Before you join Zylove')).toBeVisible()
  for (const box of await page.getByRole('checkbox').all()) await box.check()
  await page.getByRole('button', { name: 'I agree — continue' }).click()

  // 2. Name + birthday
  await page.getByLabel('Your first name').fill('Riley')
  await page.getByLabel('What should we call you?').fill('Riley')
  await page.getByLabel('Birth month').selectOption({ label: 'March' })
  await page.getByLabel('Birth day').selectOption({ label: '14' })
  await page.getByLabel('Birth year').selectOption({ label: '1994' })
  await next()

  // 3. Photos
  await page.locator('input[type=file]').setInputFiles(FIXTURE)
  await expect(page.getByLabel('Remove photo 1')).toBeVisible()
  await next()

  // 4. Gender, 5. intention, 6. recommendation
  await page.getByRole('button', { name: 'Man', exact: true }).click()
  await next()
  await page.getByRole('button', { name: /A real relationship/ }).click()
  await page.getByRole('button', { name: 'Continue →' }).click()
  await page.getByRole('button', { name: /Build my Spark profile/ }).click()

  // 7–8. Attracted to, relationship
  // The "Trans men" / "Trans women" choices are retired (2026-10-09).
  await expect(page.getByRole('button', { name: 'Women', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Trans (men|women)$/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Women', exact: true }).click()
  await next()
  await page.getByRole('button', { name: /^Single/ }).click()
  await page.getByRole('button', { name: /^Monogamy/ }).click()
  await next()

  // 9. Body type (skip), 10. height (F-018: optional, no default — skipped)
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await expect(page.getByRole('button', { name: '+ Add my height' })).toBeVisible()
  await page.getByRole('button', { name: 'Skip — leave it off my profile' }).click()

  // 11–17. Lifestyle, habits (optional), personality, values, weekend, love x2
  await page.getByRole('button', { name: /Homebody/ }).first().click()
  await next()
  await next()
  await page.getByRole('button', { name: /Funny/ }).click()
  await next()
  await page.getByRole('button', { name: 'Trust', exact: true }).click()
  await next()
  await page.getByRole('button', { name: /Slow mornings/ }).click()
  await next()
  await page.getByRole('button', { name: /Full attention/ }).click()
  await next()
  await page.getByRole('button', { name: /Full attention/ }).click()
  await next()

  // 18–21. Beliefs, kids (skip), physical prefs, needs (optional)
  await page.getByRole('button', { name: 'Skip — keep both private' }).click()
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await next()
  await next()

  // 22. Discovery (defaults valid)
  await next()

  // 23. Prompts: pick 3, answer each
  for (let i = 0; i < 3; i++) {
    const list = page.getByText('Choose a prompt').locator('..').getByRole('button')
    await list.first().click()
  }
  const answers = page.locator('textarea')
  await expect(answers).toHaveCount(3)
  for (let i = 0; i < 3; i++) await answers.nth(i).fill(`Answer number ${i + 1}`)
  await next()

  // 24. Go deeper (skip) → bio (AI fails soft → skip)
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await page.getByRole('button', { name: 'Skip bio for now' }).click()

  // 27. Review → create
  await expect(page.getByText("Here's you.")).toBeVisible()
  await page.getByRole('button', { name: 'Create my profile' }).click()
  await page.waitForURL(/\/(discover|profile)/, { timeout: 90000 })

  const u = await userDoc(uid)
  expect(u.onboardingComplete).toBe(true)
  expect(u.displayName).toBe('Riley')
  // §4.A2: gender owner-only in private/matching; the public doc has only
  // the server-built line (empty for a man who didn't choose to show it).
  expect(u.genderIdentity).toBeUndefined()
  expect((await db.doc(`users/${uid}/private/matching`).get()).data()?.genderIdentity).toBe('man')
  await expect.poll(async () => (await userDoc(uid)).genderLine, { timeout: 20000 }).toBe('')
  // F-018: height skipped → none on the profile.
  expect(u.heightCm).toBeUndefined()
  expect((await db.doc(`users/${uid}/sparkProfile/data`).get()).data()?.height).toBeUndefined()
  expect(u.genderHidden).toBeUndefined()
  // Stage 3: preferences owner-only, suspension server-only.
  expect(u.attractedTo).toBeUndefined()
  expect((await db.doc(`users/${uid}/private/matching`).get()).data()?.attractedTo).toEqual(['women'])
  expect(u.isSuspended).toBeUndefined()
  expect((await db.doc(`userInternal/${uid}`).get()).data()?.isSuspended).toBe(false) // initUserDefaults ran
  expect(typeof u.sortKey).toBe('number')
  expect((await db.doc(`users/${uid}/sparkProfile/data`).get()).exists).toBe(true)
  // The photo went to Storage and through onPhotoUpload (moderation can't
  // reach Sightengine here, so it lands in pending review, as in production
  // when moderation fails).
  await expect.poll(async () => {
    const d = await userDoc(uid)
    const acct = (await db.doc(`users/${uid}/private/account`).get()).data() ?? {}
    return (d.photoURLs?.length ?? 0) + (acct.pendingPhotoURLs?.length ?? 0)
  }, { timeout: 45000 }).toBeGreaterThan(0)
  // F-024: terms acceptance recorded server-side.
  expect((await db.doc(`users/${uid}/legalAcceptance/main`).get()).data()).toMatchObject({ termsVersion: '2026-10-08', source: 'web' })
  // Stage 1a: the birthday is private, nothing private on the public doc.
  expect(u.birthday).toBeUndefined()
  expect(u.lastActive).toBeUndefined()
  expect(u.geohash).toBeUndefined()
  expect((await db.doc(`users/${uid}/private/identity`).get()).data()?.birthday).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(net.errors).toEqual([])
  await ctx.close()
})
