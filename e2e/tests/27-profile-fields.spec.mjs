import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, FIXTURE, db, userDoc, likeAs } from './helpers.mjs'

// F-018: religion and politics never shown to other members; gender can be
// hidden; height optional; anonymous Spark likers show no personal details.
// Also takes the screenshots for the policy/F-018 report.
const SHOTS = new URL('../../shots/', import.meta.url).pathname
const PHONE = { width: 430, height: 932 }
const LAPTOP = { width: 1280, height: 900 }

test.beforeEach(resetEmulators)

async function open(browser, user) {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, user.uid)
  await page.addInitScript((u) => sessionStorage.setItem(`zylove_profile_question_${u}`, '{}'), user.uid)
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page, net }
}

async function shots(page, name) {
  for (const [label, size] of [['1280', LAPTOP], ['430', PHONE]]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}f018-${name}-${label}.png` })
  }
}

test('F-018: Explore shows relationship status but never religion or politics', async ({ browser }) => {
  const viewer = await seedUser('Alex')
  await seedUser('Blair', {
    genderIdentity: 'woman', attractedTo: ['men'], relationshipStatus: 'single', religion: 'catholic', politicalView: 'independent',
  })
  const { ctx, page, net } = await open(browser, viewer)
  await expect(page.getByRole('heading', { name: /^Blair\b/ }).first()).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('Relationship status').first()).toBeVisible()
  await expect(page.getByText('Religion', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Politics', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/Catholic|Independent/)).toHaveCount(0)
  await page.getByText('Life details').first().scrollIntoViewIfNeeded()
  await shots(page, 'explore-life-details')
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('F-018: an anonymous Spark liker shows no gender, pronouns or life details', async ({ browser }) => {
  const me = await seedUser('Finley', { genderIdentity: 'woman', attractedTo: ['men'] })
  const liker = await seedUser('Gray', {
    genderIdentity: 'trans_man', pronouns: 'he/him', relationshipStatus: 'single', parentalCurrent: 'no_kids', religion: 'jewish',
  })
  await likeAs(liker.uid, me.uid)
  const { ctx, page, net } = await open(browser, me)
  await page.getByRole('link', { name: 'Sparks' }).click()
  await page.getByRole('button', { name: /compatibility report is ready/ }).first().click()
  await expect(page.getByText(/feels a Spark/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Someone' })).toBeVisible()
  for (const t of ['Gray', 'he/him', 'trans man', 'Life details', 'Relationship status', 'Kids', 'Religion']) {
    await expect(page.getByText(t, { exact: true })).toHaveCount(0)
  }
  await shots(page, 'anonymous-liker')
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('F-018: "Don\'t show my gender" in Edit profile hides it on the profile; delete dialog wording', async ({ browser }) => {
  const me = await seedUser('Cleo', { genderIdentity: 'trans_woman', attractedTo: ['men'] })
  const { ctx, page, net } = await open(browser, me)
  await page.goto('/profile')
  await expect(page.getByText(/trans woman/i).first()).toBeVisible()

  await page.goto('/profile/edit')
  const box = page.getByRole('checkbox', { name: /Don't show my gender on my profile/ })
  await expect(box).not.toBeChecked()
  await box.check()
  await box.scrollIntoViewIfNeeded()
  await shots(page, 'edit-profile-gender')
  await page.setViewportSize(LAPTOP)
  await page.getByRole('button', { name: /^Save/ }).first().click()
  await expect.poll(async () => (await userDoc(me.uid)).genderHidden, { timeout: 20000 }).toBe(true)
  expect((await userDoc(me.uid)).genderIdentity).toBe('trans_woman') // still there, still locked
  await page.goto('/profile')
  await expect(page.getByRole('heading', { name: /^Cleo/ }).first()).toBeVisible()
  await expect(page.getByText(/trans woman/i)).toHaveCount(0)

  // The delete-account dialog: recovery record, messages, billing.
  await page.goto('/settings')
  await page.getByRole('button', { name: /^Delete account/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
  await expect(dialog.getByText(/read-only copy of each chat, shown as "Deleted User"/)).toBeVisible()
  await expect(dialog.getByText(/recovery record .* for 18 months/)).toBeVisible()
  await expect(dialog.getByText(/Deleting your account cancels it: it won't renew, and the rest of the current period isn't refunded/)).toBeVisible()
  await shots(page, 'delete-dialog')
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('F-018: onboarding — gender can be hidden, height is optional, beliefs are private', async ({ browser }) => {
  test.setTimeout(180000)
  const phone = '+15550108877'
  const ctx = await browser.newContext({ ...CONTEXT, geolocation: { latitude: 41.26, longitude: -95.94 } })
  const page = await ctx.newPage()
  await offline(page)
  await signIn(page, phone, { expectPath: /\/onboarding/ })
  const next = () => page.getByRole('button', { name: /^(Next|Continue →)$/ }).click()

  await expect(page.getByText('Before you join Zylove')).toBeVisible()
  for (const box of await page.getByRole('checkbox').all()) await box.check()
  await page.getByRole('button', { name: 'I agree — continue' }).click()
  await page.getByLabel('Your first name').fill('Riley')
  await page.getByLabel('What should we call you?').fill('Riley')
  await page.getByLabel('Birth month').selectOption({ label: 'March' })
  await page.getByLabel('Birth day').selectOption({ label: '14' })
  await page.getByLabel('Birth year').selectOption({ label: '1994' })
  await next()
  await page.locator('input[type=file]').setInputFiles(FIXTURE)
  await expect(page.getByLabel('Remove photo 1')).toBeVisible()
  await next()

  // Gender: the hide option.
  await page.getByRole('button', { name: 'Non-binary', exact: true }).click()
  await page.getByRole('checkbox', { name: /Don't show on my profile/ }).check()
  await shots(page, 'onboarding-gender')
  await page.setViewportSize(LAPTOP)
  await next()
  await page.getByRole('button', { name: /A real relationship/ }).click()
  await page.getByRole('button', { name: 'Continue →' }).click()
  await page.getByRole('button', { name: /Build my Spark profile/ }).click()
  await page.getByRole('button', { name: 'Women', exact: true }).click()
  await next()
  await page.getByRole('button', { name: /^Single/ }).click()
  await page.getByRole('button', { name: /^Monogamy/ }).click()
  await next()
  await page.getByRole('button', { name: 'Skip for now' }).click()

  // Height: nothing preset.
  await expect(page.getByRole('button', { name: '+ Add my height' })).toBeVisible()
  await expect(page.getByLabel('Height feet')).toHaveCount(0)
  await shots(page, 'onboarding-height-empty')
  await page.setViewportSize(LAPTOP)
  await page.getByRole('button', { name: '+ Add my height' }).click()
  await expect(page.getByLabel('Height feet')).toBeVisible()
  await shots(page, 'onboarding-height-added')
  await page.setViewportSize(LAPTOP)
  await page.getByRole('button', { name: 'Remove — leave it off my profile' }).click()

  // Lifestyle … love languages, then Beliefs.
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
  await expect(page.getByText(/Never shown on your profile — only used to match you/)).toBeVisible()
  await shots(page, 'onboarding-beliefs')
  await ctx.close()
})
