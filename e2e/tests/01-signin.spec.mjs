import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, userDoc } from './helpers.mjs'

test.beforeEach(resetEmulators)

test('sign-in: phone OTP → onboarded user lands on Explore', async ({ browser }) => {
  const a = await seedUser('Avery')
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, a.uid)
  await signIn(page, a.phone, { expectPath: /\/discover/ })
  await expect(page.getByRole('link', { name: 'Settings' }).or(page.getByLabel(/^Settings/))).toBeVisible()
  // Signing in published a chat public key for this browser.
  await expect.poll(async () => (await userDoc(a.uid)).publicKey?.length ?? 0).toBeGreaterThan(20)
  expect(net.errors).toEqual([])
  expect(net.external).toEqual([])
  await ctx.close()
})

test('sign-in: new number → sent to onboarding', async ({ browser }) => {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await signIn(page, '+15550109999', { expectPath: /\/onboarding/ })
  await expect(page.getByText('Before you join Zylove')).toBeVisible()
  await ctx.close()
})
