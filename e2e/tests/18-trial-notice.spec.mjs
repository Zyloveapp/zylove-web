// Trial-ended notice: "Continue with Free" sticks across a full page reload.
import { test, expect } from '@playwright/test'
import { Timestamp } from 'firebase-admin/firestore'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, db, fnLib } from './helpers.mjs'

test.beforeEach(resetEmulators)

test('trial ended: "Continue with Free" is remembered after a reload', async ({ browser }) => {
  const u = await seedUser('Tess')
  const other = await seedUser('Uma', { genderIdentity: 'woman', attractedTo: ['men'] })
  await db.doc(`userInternal/${u.uid}`).set(
    { subscriptionTier: 'free', trialStartedAt: Timestamp.fromMillis(Date.now() - 40 * 864e5), trialEndsAt: Timestamp.fromMillis(Date.now() - 10 * 864e5), trialExpired: true },
    { merge: true },
  )
  await fnLib('playAccess').refreshPlayAccess(u.uid)
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, u.uid)
  await signIn(page, u.phone, { expectPath: /\/discover/ })
  const notice = page.getByText('Your free trial has ended.')
  await expect(notice).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Continue with Free' }).click()
  await expect(notice).toBeHidden()
  // Full page loads — a reload, and straight onto another route (the notice
  // used to come back on these).
  for (const go of [() => page.reload(), () => page.goto(`http://localhost:5409/profile/${other.uid}`), () => page.goto('http://localhost:5409/matches')]) {
    await go()
    await expect(page.getByRole('link', { name: /Explore/ }).first()).toBeVisible({ timeout: 20000 })
    await page.waitForTimeout(4000)
    await expect(notice).toBeHidden()
  }
  await ctx.close()
})
