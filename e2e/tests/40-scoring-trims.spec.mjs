// F-100 / F-098 (2026-10-09): scoring outputs trimmed so they can't be read
// back into someone's private data. Intent is no longer scored (the Spark+
// core fit bar showed it); Deep Fit (Elite) and Play's tier1 are stored and
// returned only as archetype id/label/copy, a rounded score, fit in bands of
// 5, an asymmetry band and the reasons — older stored docs are trimmed at
// read time; the Spark+ physical bar is the viewer's own direction; a Play
// tap is gated by plan as Spark is.
import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, callAs, likeAs, setPlan, playIdOf, sortedPair, db,
} from './helpers.mjs'

test.beforeEach(resetEmulators)

const woman = (name, o = {}, opts = {}) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o }, opts)
const PLAY = (name) => ({ playDisplayName: name, playBio: `${name}'s Play bio`, spiceLevel: 'spicy', playInterestTags: ['fwb', 'playful', 'kissing'] })

const RECORD_KEYS = ['archetype', 'asymmetryBand', 'combinedScore', 'differences', 'enoughInfo', 'fitFor', 'strengths']
const RAW = ['confidence', 'coverage', 'dataConfidence', 'asymmetryGap', 'directions']

// A Deep Fit record in the public shape (scoring.ts publicDeepFit).
function expectPublicDeepFit(t, uids) {
  expect(Object.keys(t).sort()).toEqual(RECORD_KEYS)
  expect(Number.isInteger(t.combinedScore)).toBe(true)
  expect(Object.keys(t.fitFor).sort()).toEqual([...uids].sort())
  for (const v of Object.values(t.fitFor)) expect(v % 5).toBe(0)
  expect([0, 1, 2, 3]).toContain(t.asymmetryBand)
  if (t.archetype) expect(Object.keys(t.archetype).sort()).toEqual(['copy', 'id', 'label'])
  const json = JSON.stringify(t)
  for (const k of RAW) expect(json, k).not.toContain(k)
}

// Fuller answers, so Deep Fit has something to say.
const ANSWERS = {
  personalityTraits: ['grounded', 'caring', 'intellectual'],
  relationshipValues: ['stability', 'loyalty', 'communication'],
  lifestyleTags: ['homebody', 'wellness_focused', 'foodie'],
  weekendVibes: ['slow_mornings', 'cook_something_good', 'recharge_solo'],
  habitTags: ['reader', 'early_riser', 'doesnt_drink', 'meditates'],
  loveLangGive: ['quality_time', 'acts_of_service'],
  loveLangReceive: ['quality_time', 'acts_of_service'],
  conflictStyle: 'process_first', togethernessStyle: 'entwined', stressResponse: 'talk_it_out',
  parentalCurrent: 'no_kids', parentalIntent: 'wants_first',
}

test('F-098: an Elite tap and the stored Deep Fit carry no raw floats, confidence or coverage; old docs are trimmed at read', async () => {
  const a = await seedUser('Abe', ANSWERS)
  const b = await woman('Bea', { ...ANSWERS, dealbreakers: ['vaper'] })
  await setPlan(a.uid, 'elite')
  const tap = await callAs(a.uid, 'onTap', { tappedUserId: b.uid })
  expect(tap.engineVersion).toBe(3)
  expectPublicDeepFit(tap.tier1, [a.uid, b.uid])
  expect(tap.tier1.combinedScore).toBe(tap.sparkScore)
  const id = sortedPair(a.uid, b.uid)
  expectPublicDeepFit((await db.doc(`pairs/${id}/modes/deep`).get()).data().tier1Spark, [a.uid, b.uid])

  // A doc stored before the trim (raw floats) is trimmed on the way out.
  // First let the re-scores from seeding and the plan change land (the plan
  // mirror writes the public doc, whose trigger re-scores the pair), or one
  // would overwrite the old doc planted below.
  const deepRef = db.doc(`pairs/${id}/modes/deep`)
  for (let i = 0, last = ''; i < 30; i++) {
    const t = String((await deepRef.get()).updateTime?.toMillis())
    if (t === last) break
    last = t
    await new Promise((r) => setTimeout(r, 2500))
  }
  await deepRef.set({
    tier1Spark: {
      archetype: { id: 'kindred', label: 'Kindred', copy: 'c', confidence: 0.8312 },
      combinedScore: 71.837, asymmetryGap: 12.34, dataConfidence: 0.71, coverage: 0.71, enoughInfo: true,
      strengths: ['Integrity'], differences: [], fitFor: { [a.uid]: 73, [b.uid]: 66 },
    },
  })
  const again = await callAs(a.uid, 'onTap', { tappedUserId: b.uid })
  expect(again.tier1).toEqual({
    archetype: { id: 'kindred', label: 'Kindred', copy: 'c' }, combinedScore: 72,
    fitFor: { [a.uid]: 75, [b.uid]: 65 }, asymmetryBand: 2, strengths: ['Integrity'], differences: [], enoughInfo: true,
  })
  // …and in the Sent tab (Elite: Deep Fit included).
  await callAs(a.uid, 'onLike', { likedUserId: b.uid, mode: 'spark' })
  const { sent } = await callAs(a.uid, 'getSentSparks', { mode: 'spark' })
  expect(sent).toHaveLength(1)
  expectPublicDeepFit(sent[0].tier1Spark, [a.uid, b.uid])
  // The like may re-score the pair (a fresh, trimmed record replaces the old
  // doc) — either way only the public archetype goes out (the same
  // loadSparkDetails read the tap above checked on the old doc).
  expect(Object.keys(sent[0].tier1Spark.archetype ?? {}).sort()).toEqual(['copy', 'id', 'label'])
})

test("F-100: a Spark+ breakdown's core fit (and the headline) doesn't move when the other person's intent changes", async () => {
  const a = await seedUser('Cal', ANSWERS)
  const b = await woman('Dee', { ...ANSWERS, intent: 'spark' })
  await setPlan(a.uid, 'spark_plus')
  const before = await callAs(a.uid, 'onTap', { tappedUserId: b.uid })
  expect(before.breakdown.spark.coreFit).toBe(100)
  const id = sortedPair(a.uid, b.uid)
  const version = (await db.doc(`pairs/${id}`).get()).data().scoreVersion
  // She now uses Play too ('open'): the pair is re-scored (onPrivateProfileWrite).
  await db.doc(`users/${b.uid}/private/profile`).set({ intent: 'open' }, { merge: true })
  await expect.poll(async () => (await db.doc(`pairs/${id}`).get()).data().scoreVersion, { timeout: 20000 }).toBeGreaterThan(version)
  const after = await callAs(a.uid, 'onTap', { tappedUserId: b.uid })
  expect(after.breakdown.spark.coreFit).toBe(before.breakdown.spark.coreFit)
  expect(after.sparkScore).toBe(before.sparkScore)
})

test("F-098: the Spark+ physical bar is each viewer's own direction", async () => {
  // Bea wants tall athletic men and Abe is one; Abe wants slim and Bea is curvy.
  const a = await seedUser('Abe', { heightCm: 188, bodyType: 'athletic', seekingBodyTypes: ['slim'] })
  const b = await woman('Bea', { heightCm: 165, bodyType: 'curvy', seekingBodyTypes: ['athletic'], seekingHeightMinCm: 180, seekingHeightMaxCm: 200 })
  for (const u of [a, b]) await setPlan(u.uid, 'spark_plus')
  const his = await callAs(a.uid, 'onTap', { tappedUserId: b.uid })
  const hers = await callAs(b.uid, 'onTap', { tappedUserId: a.uid })
  expect(his.breakdown.spark.physicalPrefs).toBe(30)
  expect(hers.breakdown.spark.physicalPrefs).toBe(100)
  for (const r of [his, hers]) expect(r.breakdown.spark.physicalPrefsFor).toBeUndefined()
  // Stored per uid (server-only).
  const stored = (await db.doc(`pairs/${sortedPair(a.uid, b.uid)}/modes/spark`).get()).data().sparkBreakdown
  expect(stored.physicalPrefsFor).toEqual({ [a.uid]: 30, [b.uid]: 100 })
  expect(stored.physicalPrefs).toBeUndefined()
  // A viewer with no preferences of their own gets no physical bar.
  const c = await seedUser('Cy', { heightCm: 188, bodyType: 'athletic' })
  await setPlan(c.uid, 'spark_plus')
  expect((await callAs(c.uid, 'onTap', { tappedUserId: b.uid })).breakdown.spark.physicalPrefs).toBeNull()
})

test('F-098: Play — no Play answer without Play access (Free, Spark+); Elite gets the breakdown and an archetype without confidence', async () => {
  const a = await seedUser('Ari', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ember') })
  const b = await woman('Bex', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Velvet') })
  const plus = await seedUser('Pat', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Moss') })
  await setPlan(a.uid, 'elite')
  await setPlan(plus.uid, 'spark_plus')
  const free = await seedUser('Fen', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Fern') })
  await setPlan(free.uid, 'free')
  const bPlay = await playIdOf(b.uid)
  // Play is an Elite feature (Stage C): Free and Spark+ get no Play scores at all.
  for (const u of [plus, free]) await expect(callAs(u.uid, 'onTap', { tappedPlayId: bPlay })).rejects.toThrow(/permission-denied|PERMISSION_DENIED/)

  const tap = await callAs(a.uid, 'onTap', { tappedPlayId: bPlay })
  expect(tap.engineVersion).toBe(3)
  expect(typeof tap.playScore).toBe('number')
  expect(Object.keys(tap.breakdown.play).sort()).toEqual(['energyVibe', 'intentionsLimits', 'nonNegotiables', 'physicalCompatibility'])
  if (tap.playArchetype) expect(Object.keys(tap.playArchetype).sort()).toEqual(['copy', 'id', 'label'])
  // An old stored label (with its confidence) is trimmed on the way out.
  const key = [await playIdOf(a.uid), bPlay].sort().join('_')
  await db.doc(`playPairData/${key}`).update({
    tier1Play: { archetype: { id: 'slow_burn', label: 'Slow Burn', copy: 'p', confidence: 0.91 }, combinedScore: 64, asymmetryGap: 0, dataConfidence: 1 },
  })
  const again = await callAs(a.uid, 'onTap', { tappedPlayId: bPlay })
  expect(again.playArchetype).toEqual({ id: 'slow_burn', label: 'Slow Burn', copy: 'p' })
  expect(JSON.stringify(again)).not.toMatch(/confidence|asymmetryGap|dataConfidence/)
  // A re-score stores the trimmed shape.
  await db.doc(`users/${a.uid}/playProfile/data`).update({ playBio: 'changed' })
  await expect.poll(async () => JSON.stringify((await db.doc(`playPairData/${key}`).get()).data().tier1Play ?? null), { timeout: 20000 }).not.toContain('confidence')
})

test('F-098: the Deep Fit card still renders for Elite, with fit in bands of 5', async ({ browser }) => {
  const me = await seedUser('Eli', ANSWERS)
  const other = await woman('Fay', ANSWERS)
  await setPlan(me.uid, 'elite')
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, me.uid)
  await page.addInitScript((u) => sessionStorage.setItem(`zylove_profile_question_${u}`, '{}'), me.uid)
  await signIn(page, me.phone, { expectPath: /\/discover/ })
  await page.goto(`/profile/${other.uid}`)
  await expect(page.getByText('✦ Deep Fit')).toBeVisible({ timeout: 20000 })
  const fits = page.getByText('How they fit what you want').locator('xpath=preceding-sibling::p[1]')
  await expect(fits).toHaveText(/^\d*[05]%$/)
  await expect(page.getByText('How you fit what they want').locator('xpath=preceding-sibling::p[1]')).toHaveText(/^\d*[05]%$/)
  await expect(page.getByText('Where you line up')).toBeVisible()
  expect(net.errors).toEqual([])
  await ctx.close()
})
