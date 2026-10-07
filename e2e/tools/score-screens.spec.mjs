// Screenshots of the compatibility score as Free, Spark+ and Elite, for a
// full pair, a "Not enough info" pair and a dealbreaker pair. Emulator only;
// not part of the suite. Run: ./run.sh tools/score-screens.spec.mjs
// (output: e2e/shots/, gitignored).
import { test, expect } from '@playwright/test'
import { Timestamp } from 'firebase-admin/firestore'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, db, fnLib } from '../tests/helpers.mjs'

const OUT = new URL('../shots/emulator/', import.meta.url).pathname

const FULL = {
  personalityTraits: ['grounded', 'caring', 'intellectual'],
  relationshipValues: ['stability', 'loyalty', 'communication'],
  lifestyleTags: ['homebody', 'wellness_focused', 'foodie'],
  weekendVibes: ['slow_mornings', 'cook_something_good', 'recharge_solo'],
  habitTags: ['reader', 'early_riser', 'meditates', 'coffee_addict'],
  loveLangGive: ['quality_time', 'acts_of_service'],
  loveLangReceive: ['quality_time', 'acts_of_service'],
  conflictStyle: 'process_first', togethernessStyle: 'entwined', stressResponse: 'talk_it_out',
  parentalCurrent: 'no_kids', parentalIntent: 'wants_first',
  religion: 'christian', politicalView: 'center_left', drinkingHabit: 'socially',
}

async function setTier(uid, tier) {
  const plan =
    tier === 'free'
      ? { subscriptionTier: 'free', trialStartedAt: Timestamp.fromMillis(Date.now() - 40 * 864e5), trialEndsAt: Timestamp.fromMillis(Date.now() - 10 * 864e5), trialExpired: true }
      : { subscriptionTier: tier }
  await db.doc(`userInternal/${uid}`).set(plan, { merge: true })
  await fnLib('playAccess').refreshPlayAccess(uid)
}

test.beforeAll(resetEmulators)

test('score screens by plan', async ({ browser }) => {
  test.setTimeout(600000)
  const woman = { genderIdentity: 'woman', attractedTo: ['men'] }
  const full = await seedUser('Rowan', { ...woman, ...FULL, personalityTraits: ['caring', 'romantic', 'grounded'] })
  const thin = await seedUser('Quinn', { ...woman, personalityTraits: ['funny'], relationshipValues: [], lifestyleTags: [], weekendVibes: ['no_plan'], loveLangGive: [], loveLangReceive: [] })
  const smoker = await seedUser('Skye', { ...woman, ...FULL, habitTags: ['reader', 'cigarette_smoker', 'meditates', 'coffee_addict'] })
  const shots = []
  for (const tier of ['free', 'spark_plus', 'elite']) {
    const viewer = await seedUser(`Viewer${tier.replace('_', '')}`, { ...FULL, dealbreakers: ['cigarette_smoker'] })
    await setTier(viewer.uid, tier)
    const ctx = await browser.newContext({ ...CONTEXT, viewport: { width: 430, height: 1600 } })
    const page = await ctx.newPage()
    await offline(page)
    await quietFirstRun(page, viewer.uid)
    // A Free user who already chose "Continue with Free".
    await page.addInitScript((u) => localStorage.setItem(`zylove_trial_ended_seen_${u}`, '1'), viewer.uid)
    await signIn(page, viewer.phone, { expectPath: /\/(discover|onboarding)/ })
    // Free here means a finished trial: dismiss its one-time notice.
    const keepFree = page.getByRole('button', { name: 'Continue with Free' })
    if (await keepFree.isVisible({ timeout: 5000 }).catch(() => false)) await keepFree.click()
    for (const [label, target] of [['full', full], ['not-enough-info', thin], ['dealbreaker', smoker]]) {
      await page.goto(`http://localhost:5409/profile/${target.uid}`)
      for (let i = 0; i < 3; i++) {
        if (await keepFree.isVisible({ timeout: 2500 }).catch(() => false)) await keepFree.click()
      }
      await expect(page.getByText(/Not enough info|%/).first()).toBeVisible({ timeout: 30000 })
      await page.waitForTimeout(1200)
      const file = `${OUT}${tier}-${label}.png`
      await page.screenshot({ path: file, clip: { x: 0, y: 380, width: 430, height: 1150 } })
      const pair = (await db.doc(`pairs/${[viewer.uid, target.uid].sort().join('_')}`).get()).data()
      shots.push(`${tier}/${label}: sparkScore ${pair?.sparkScore} enoughInfo ${pair?.sparkEnoughInfo} engine ${pair?.engineVersion}`)
    }
    await ctx.close()
  }
  console.log(shots.join('\n'))
})
