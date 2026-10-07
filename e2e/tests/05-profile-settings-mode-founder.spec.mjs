import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, userDoc, internalDoc, LEGACY, PHOTO, FIXTURE, db } from './helpers.mjs'

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

test('profile: own profile renders, edit pronouns saves; other profile renders', async ({ browser }) => {
  const me = await seedUser('Logan')
  const other = await seedUser('Morgan', { genderIdentity: 'woman', attractedTo: ['men'] })
  const { ctx, page, net } = await open(browser, me)
  await page.getByRole('link', { name: 'Me' }).click()
  await expect(page.getByRole('heading', { name: 'Logan, 30' })).toBeVisible()
  await page.getByRole('link', { name: '✏ Edit my profile' }).click()
  await page.getByPlaceholder('e.g. she/her, they/them').fill('he/him')
  await page.getByRole('button', { name: 'Save Spark profile' }).click()
  await expect(page.getByText(/Saved ✦/)).toBeVisible()
  await expect.poll(async () => (await userDoc(me.uid)).pronouns).toBe('he/him')
  await page.goto(`/profile/${other.uid}`)
  await expect(page.getByRole('heading', { name: 'Morgan, 30' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Send a Spark/ })).toBeVisible()
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('settings: photo-analysis toggle persists across reload', async ({ browser }) => {
  const me = await seedUser('Noel')
  const { ctx, page } = await open(browser, me)
  await page.goto('/settings')
  const sw = page.getByRole('switch', { name: 'Analyze my Spark photos' })
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await sw.click()
  await page.getByRole('button', { name: 'I understand, enable' }).click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await expect.poll(async () => (await db.doc(`users/${me.uid}/private/settings`).get()).data()?.photoAnalysisConsent?.spark).toBe(true)
  expect((await userDoc(me.uid)).photoAnalysisConsent).toBeUndefined()
  await page.reload()
  await expect(page.getByRole('switch', { name: 'Analyze my Spark photos' })).toHaveAttribute('aria-checked', 'true')
  await ctx.close()
})

test('mode: Spark → Play with a new Play PIN, then back to Spark', async ({ browser }) => {
  const me = await seedUser('Oakley', {}, { play: { name: 'Oak', spiceLevel: 'spicy', arrangement: 'fwb', bio: 'Play bio' } })
  const { ctx, page, net } = await open(browser, me)
  await page.getByRole('button', { name: 'Spark mode — switch to Play' }).click()
  await expect(page.getByText('Create your Play PIN')).toBeVisible()
  await page.keyboard.type('2468')
  await expect(page.getByText('Confirm your PIN')).toBeVisible()
  await page.keyboard.type('2468')
  await expect(page.getByRole('button', { name: 'Play mode — switch to Spark' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByRole('link', { name: 'Flames' })).toBeVisible()
  await page.getByRole('button', { name: 'Play mode — switch to Spark' }).click()
  await expect(page.getByRole('button', { name: 'Spark mode — switch to Play' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByRole('link', { name: 'Sparks' })).toBeVisible()
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('founder: Austin member claims a founder spot from Settings', async ({ browser }) => {
  const me = await seedUser('Parker', { smsConsent: { grantedAt: new Date() } })
  const { ctx, page, net } = await open(browser, me)
  await page.goto('/settings')
  await page.getByRole('button', { name: /Become a founder/ }).click()
  await expect(page.getByText(/You're one of the first in Austin/)).toBeVisible()
  await page.getByRole('button', { name: /I'm in — make me a founder/ }).click()
  await expect.poll(async () => (await userDoc(me.uid)).isFounder, { timeout: 20000 }).toBe(true)
  const u = await userDoc(me.uid)
  expect(u.founderCityId).toBe('austin')
  expect((await internalDoc(me.uid)).subscriptionTier).toBe('elite')
  if (!LEGACY) expect(u.subscriptionTier).toBeUndefined() // only the migration clears the old copy
  expect((await db.doc('config/city_austin').get()).data()?.menCount).toBe(1)
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('play onboarding: Spark member builds a Play profile', async ({ browser }) => {
  test.setTimeout(180000)
  const me = await seedUser('Quinn')
  const { ctx, page, net } = await open(browser, me)
  await page.goto('/play-onboarding')
  const nextBtn = () => page.getByRole('button', { name: /^(Next|Next →|Next \(optional\) →|Let's go →)$/ }).click()
  await page.getByRole('button', { name: "Let's go →" }).click()
  await page.locator('input[type=file]').setInputFiles(FIXTURE)
  await expect(page.getByLabel('Remove photo 1')).toBeVisible()
  await nextBtn()
  await page.getByLabel('Play name').fill('Q')
  await nextBtn()
  await page.getByRole('button', { name: /^Spicy/ }).click()
  await nextBtn()
  // Optional steps until the arrangement step.
  for (let i = 0; i < 6 && !(await page.getByText('What are you looking for?').isVisible()); i++) await nextBtn()
  await page.getByRole('button', { name: /FWB/ }).click()
  await nextBtn()
  for (let i = 0; i < 6 && !(await page.getByText('In your own words').isVisible()); i++) await nextBtn()
  // Prompts: three answers.
  for (let i = 0; i < 3; i++) {
    const pick = page.getByRole('button', { name: /\?$/ }).first()
    if (await pick.isVisible()) await pick.click()
  }
  const answers = page.locator('textarea')
  for (let i = 0; i < Math.min(3, await answers.count()); i++) await answers.nth(i).fill(`Play answer ${i + 1}`)
  await nextBtn()
  await page.getByRole('button', { name: 'Write it myself' }).click()
  await page.getByPlaceholder('Your Play bio…').fill('Here for a good time.')
  await nextBtn()
  await expect(page.getByText(/You're ready/)).toBeVisible()
  await page.getByRole('button', { name: '🔥 Let\'s Play' }).click()
  // Saved. The photo can't pass moderation here (no Sightengine key), so it
  // waits in review and the app says so on this screen instead of leaving.
  await expect(page.getByText('Your Play profile is saved.')).toBeVisible({ timeout: 60000 })
  await expect(page.getByText(/Photo is under review/)).toBeVisible()
  await expect.poll(async () => (await db.doc(`users/${me.uid}/playProfile/data`).get()).exists, { timeout: 20000 }).toBe(true)
  expect(net.errors).toEqual([])
  await ctx.close()
})
