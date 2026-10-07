import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, db, userDoc, internalDoc, accountDoc, locationDoc, clearLocation, Timestamp } from './helpers.mjs'

test.beforeEach(resetEmulators)

async function open(browser, user, { context = CONTEXT, quiet = true } = {}) {
  const ctx = await browser.newContext(context)
  const page = await ctx.newPage()
  const net = await offline(page)
  if (quiet) await quietFirstRun(page, user.uid)
  else await page.addInitScript((u) => {
    localStorage.setItem(`zylove_keybackup_snooze_${u}`, String(Date.now()))
    sessionStorage.setItem('zylove_early_modal_seen', '1')
    sessionStorage.setItem('zylove_bot_banner_dismissed', '1')
  }, user.uid)
  // Count geolocation requests the page makes.
  await page.addInitScript(() => {
    window.__geoCalls = 0
    const g = navigator.geolocation
    const orig = g.getCurrentPosition.bind(g)
    g.getCurrentPosition = (...a) => { window.__geoCalls++; return orig(...a) }
  })
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page, net }
}

test('trial: pre-launch Austin member sees "Free while we build the network in Austin", no trial modal', async ({ browser }) => {
  const me = await seedUser('Jo') // man, Austin, no trialStartedAt, Austin not open
  const { ctx, page, net } = await open(browser, me)
  await page.goto('/settings')
  await expect(page.getByText('Free while we build the network in Austin').first()).toBeVisible()
  await expect(page.getByText('Your free trial has ended.')).toHaveCount(0)
  await page.goto('/upgrade')
  await expect(page.getByText('Free while we build the network in Austin').first()).toBeVisible()
  expect((await internalDoc(me.uid))?.trialStartedAt).toBeUndefined()
  expect((await userDoc(me.uid)).trialStartedAt).toBeUndefined()
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('trial: an expired trial shows the blocking trial-ended modal', async ({ browser }) => {
  const me = await seedUser('Kit', {
    trialStartedAt: Timestamp.fromMillis(Date.now() - 40 * 86400000), trialEndsAt: Timestamp.fromMillis(Date.now() - 10 * 86400000), trialExpired: true,
  })
  const { ctx, page } = await open(browser, me)
  await expect(page.getByText('Your free trial has ended.')).toBeVisible()
  await ctx.close()
})

test('location gate: first-time user is asked, allows, location saved, Explore opens', async ({ browser }) => {
  const me = await seedUser('Lou', { locationLabel: '' })
  await clearLocation(me.uid)
  // First visit: the browser hasn't been asked yet (permission "prompt").
  const { permissions, ...noPermission } = CONTEXT
  const { ctx, page, net } = await open(browser, me, { quiet: false, context: noPermission })
  await expect(page.getByText('We need your location')).toBeVisible()
  // The user accepts the browser's prompt when they tap Allow.
  await ctx.grantPermissions(['geolocation'], { origin: 'http://localhost:5409' })
  // Granting may let the gate save straight away (its "already allowed" path)
  // before the tap lands; either way the location must be saved.
  await page.getByRole('button', { name: /Allow location/ }).click({ timeout: 3000 }).catch(() => {})
  await expect.poll(async () => typeof (await locationDoc(me.uid))?.lat, { timeout: 20000 }).toBe('number')
  await expect(page.getByText('We need your location')).toHaveCount(0, { timeout: 20000 })
  const loc = await locationDoc(me.uid)
  expect(Math.abs(loc.lat - 30.25)).toBeLessThan(0.1) // snapped near the granted position
  expect(loc.marketCityId).toBe('austin')
  // Coordinates never on the public doc; the owner's summary and the city label are.
  const u = await userDoc(me.uid)
  expect(u.locationLat).toBeUndefined()
  expect(u.locationLabel).toBe('Austin, TX')
  expect((await accountDoc(me.uid)).location.label).toBe('Austin, TX')
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('location gate: returning user with a saved location is not shown the ask, and location is never read on load', async ({ browser }) => {
  const me = await seedUser('Max') // saved Austin location
  // Granted, and (separately) never asked: neither reads the location nor gates Explore.
  const { permissions, ...noPermission } = CONTEXT
  for (const context of [CONTEXT, noPermission]) {
    const { ctx, page } = await open(browser, me, { quiet: false, context })
    await page.waitForTimeout(3000)
    await expect(page.getByText('We need your location')).toHaveCount(0)
    expect(await page.evaluate(() => window.__geoCalls)).toBe(0)
    await page.goto('/settings')
    await expect(page.getByTestId('location-label')).toHaveText('Austin, TX')
    expect(await page.evaluate(() => window.__geoCalls)).toBe(0)
    await ctx.close()
  }
})

async function updateFromSettings(browser, me, { mode = 'spark', context = CONTEXT } = {}) {
  const ctx = await browser.newContext(context)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, me.uid)
  await signIn(page, me.phone, { expectPath: /\/discover/ })
  if (mode === 'play') {
    // Into Play as the app does it: the toggle, then a new Play PIN.
    await page.getByRole('button', { name: 'Spark mode — switch to Play' }).click()
    await expect(page.getByText('Create your Play PIN')).toBeVisible()
    await page.keyboard.type('2468')
    await expect(page.getByText('Confirm your PIN')).toBeVisible()
    await page.keyboard.type('2468')
    await expect(page.getByRole('button', { name: 'Play mode — switch to Spark' })).toBeVisible({ timeout: 20000 })
    await page.getByRole('link', { name: 'Settings' }).click()
  } else await page.goto('/settings')
  return { ctx, page, button: page.getByRole('button', { name: /Update location|Locating/ }) }
}

for (const mode of ['spark', 'play']) {
  test(`update location: from ${mode === 'spark' ? 'Spark' : 'Play'} settings — moved, then up to date`, async ({ browser }) => {
    const me = await seedUser(mode === 'spark' ? 'Una' : 'Pam', mode === 'play' ? { intent: 'open', onboardingPath: 'both' } : {}, mode === 'play' ? { play: { playDisplayName: 'Pam', playBio: 'hi', spiceLevel: 'mild' } } : {})
    const before = await locationDoc(me.uid)
    const { ctx, page, button } = await updateFromSettings(browser, me, { mode, context: { ...CONTEXT, geolocation: { latitude: 30.40, longitude: -97.70 } } })
    // The mode's colour: cobalt in Spark, red in Play.
    await expect(button).toHaveClass(mode === 'spark' ? /bg-\[#1B4FD8\]/ : /bg-\[#E03131\]/)
    await button.click()
    await expect(page.getByText('Location updated to Austin, TX')).toBeVisible({ timeout: 15000 })
    const after = await locationDoc(me.uid)
    expect(after.lat).not.toBe(before.lat)
    expect(after.marketCityId).toBe('austin')
    // Same place again: nothing changes.
    await button.click()
    await expect(page.getByText('Your location is up to date — Austin, TX')).toBeVisible({ timeout: 15000 })
    expect((await locationDoc(me.uid)).changes).toHaveLength(after.changes.length)
    await ctx.close()
  })
}

test('update location: denied permission shows how to enable it (iPhone, Android, Mac)', async ({ browser }) => {
  const me = await seedUser('Dov')
  const before = await locationDoc(me.uid)
  const { permissions, ...noPermission } = CONTEXT
  const { ctx, page, button } = await updateFromSettings(browser, me, { context: noPermission })
  await button.click()
  await expect(page.getByText(/Location access is blocked/)).toBeVisible({ timeout: 15000 })
  await expect(page.getByText(/iPhone\/Safari:/)).toBeVisible()
  await expect(page.getByText(/Android\/Chrome:/)).toBeVisible()
  await expect(page.getByText(/System Settings → Privacy & Security → Location Services/)).toBeVisible()
  expect(await locationDoc(me.uid)).toEqual(before) // nothing saved
  await ctx.close()
})

test('update location: past the daily limit says so', async ({ browser }) => {
  const me = await seedUser('Lim')
  const now = Date.now()
  await db.doc(`userLocations/${me.uid}`).set({ changes: [now, now, now] }, { merge: true })
  const { ctx, page, button } = await updateFromSettings(browser, me, { context: { ...CONTEXT, geolocation: { latitude: 30.45, longitude: -97.65 } } })
  await button.click()
  await expect(page.getByText('You can update your location again tomorrow')).toBeVisible({ timeout: 15000 })
  await ctx.close()
})
