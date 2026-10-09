// Scoring engine v2 — sanity, caps, dealbreakers and calibration targets.
// Profiles use the web onboarding's own answers. The population is seeded,
// so results are deterministic.

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { calculateSparkScore, deepFitRecord, SCORE_ENGINE_VERSION, sparkPairFields } from '../src/legacy/scoring'
import { DEALBREAKER_CAP } from '../src/legacy/tier1/scorePair'
import type { UserDoc } from '../src/legacy/types'
import { person, quantile, rng, type Profile } from './population'

const score = (a: Profile, b: Profile) => calculateSparkScore(a as unknown as UserDoc, b as unknown as UserDoc)
const deep = (r: ReturnType<typeof score>) => r.tier1?.combinedScore ?? NaN
// "Tier 0" below is the breakdown engine's own score (r.tier0Score); the
// headline everyone sees (r.score) is Deep Fit's.

const man = (o: Profile = {}): Profile => ({ genderIdentity: 'man', attractedTo: ['women'], age: 33, ageMin: 26, ageMax: 40, intent: 'spark', ...o })
const woman = (o: Profile = {}): Profile => ({ genderIdentity: 'woman', attractedTo: ['men'], age: 31, ageMin: 28, ageMax: 40, intent: 'spark', ...o })

// A full set of answers, and its opposite in spirit.
const HOMEBODY: Profile = {
  personalityTraits: ['grounded', 'caring', 'intellectual'],
  relationshipValues: ['stability', 'loyalty', 'communication'],
  lifestyleTags: ['homebody', 'wellness_focused', 'foodie'],
  weekendVibes: ['slow_mornings', 'cook_something_good', 'recharge_solo'],
  habitTags: ['reader', 'early_riser', 'doesnt_drink', 'meditates'],
  loveLangGive: ['quality_time', 'acts_of_service'],
  loveLangReceive: ['quality_time', 'acts_of_service'],
  conflictStyle: 'process_first', togethernessStyle: 'entwined', stressResponse: 'talk_it_out',
  parentalCurrent: 'no_kids', parentalIntent: 'wants_first',
  religion: 'christian', politicalView: 'center_left', drinkingHabit: 'never',
  bodyType: 'average', heightCm: 170,
}
const NIGHT_OWL: Profile = {
  personalityTraits: ['wild_card', 'spontaneous', 'confident'],
  relationshipValues: ['independence', 'spontaneity', 'passion'],
  lifestyleTags: ['nightlife', 'social_butterfly', 'traveler'],
  weekendVibes: ['nightlife', 'go_somewhere', 'no_plan'],
  habitTags: ['night_owl', 'drinks_socially', 'gamer', '420_friendly'],
  loveLangGive: ['gift_giving', 'physical_touch'],
  loveLangReceive: ['words_of_affirmation', 'gift_giving'],
  conflictStyle: 'avoid', togethernessStyle: 'independent', stressResponse: 'step_back',
  parentalCurrent: 'has_kids', parentalIntent: 'doesnt_want_more',
  religion: 'atheist', politicalView: 'conservative', drinkingHabit: 'regularly',
  bodyType: 'curvy', heightCm: 158,
}

test('engine version and pair fields', () => {
  const r = score(man(HOMEBODY), woman(HOMEBODY))
  assert.deepEqual(sparkPairFields(r), { sparkScore: r.score, sparkEnoughInfo: r.enoughInfo, engineVersion: SCORE_ENGINE_VERSION })
  assert.equal(SCORE_ENGINE_VERSION, 3)
})

test('the headline is the Deep Fit score, with both directions and reasons', () => {
  const r = score(man(HOMEBODY), woman({ ...HOMEBODY, personalityTraits: ['caring', 'romantic', 'funny'] }))
  assert.equal(r.score, Math.round(deep(r)))
  const t = r.tier1!
  for (const v of [t.directions.ab, t.directions.ba]) assert.ok(v >= 0 && v <= 100, `direction ${v}`)
  assert.ok(t.strengths.length > 0, 'no strengths')
  const rec = deepFitRecord(t, 'uidA', 'uidB') as { fitFor: Record<string, number>; directions?: unknown }
  assert.deepEqual(rec.fitFor, { uidA: Math.round(t.directions.ab), uidB: Math.round(t.directions.ba) })
  assert.equal(rec.directions, undefined)
})

test('no reasons without enough info', () => {
  const r = score(man(), woman(HOMEBODY))
  assert.deepEqual([r.tier1!.strengths, r.tier1!.differences], [[], []])
})

// F-100: intent is no longer scored, so the opposites no longer get the
// extra drop a different intent gave (spark vs open: 20 before, now the 54
// a same-intent pair of opposites already scored).
test('opposite profiles score low (Tier 0 < 40, Deep Fit "Some differences")', () => {
  const r = score(man({ ...HOMEBODY, intent: 'spark' }), woman({ ...NIGHT_OWL, intent: 'open' }))
  assert.equal(r.enoughInfo, true)
  assert.ok(r.tier0Score < 40, `Tier 0 ${r.tier0Score}`)
  assert.ok(deep(r) < 60, `Deep Fit ${deep(r)}`)
})

test('F-100: intent changes neither the headline nor the core fit bar', () => {
  const base = score(man(HOMEBODY), woman({ ...HOMEBODY, intent: 'spark' }))
  for (const intent of ['open', 'play', undefined]) {
    const r = score(man(HOMEBODY), woman({ ...HOMEBODY, intent }))
    assert.equal(r.score, base.score, `headline with ${intent}`)
    assert.equal(r.tier0Score, base.tier0Score, `Tier 0 with ${intent}`)
    assert.equal(r.breakdown.coreFit, base.breakdown.coreFit, `coreFit with ${intent}`)
    assert.deepEqual(r.tier1!.directions, base.tier1!.directions, `directions with ${intent}`)
  }
  // Age range and attraction still count: 100 mutual, 50 one-way.
  assert.equal(base.breakdown.coreFit, 100)
  assert.equal(score(man({ ...HOMEBODY, ageMax: 30 }), woman(HOMEBODY)).breakdown.coreFit, 75)
})

test('identical profiles score high (> 85) in both engines', () => {
  const r = score(man(HOMEBODY), woman(HOMEBODY))
  assert.equal(r.enoughInfo, true)
  assert.ok(r.tier0Score > 85, `Tier 0 ${r.tier0Score}`)
  assert.ok(deep(r) > 85, `Deep Fit ${deep(r)}`)
})

test('blank profiles are "Not enough info" and score low (< 50)', () => {
  for (const [a, b] of [[man(), woman()], [man(HOMEBODY), woman()], [man(), woman(NIGHT_OWL)]]) {
    const r = score(a, b)
    assert.equal(r.enoughInfo, false)
    assert.ok(r.tier0Score < 50, `Tier 0 ${r.tier0Score}`)
    assert.ok(deep(r) < 50, `Deep Fit ${deep(r)}`)
  }
})

test('a mostly blank profile is "Not enough info" and scores low', () => {
  const thin = { personalityTraits: ['funny'], weekendVibes: ['no_plan'], conflictStyle: 'direct' }
  const r = score(man(thin), woman(HOMEBODY))
  assert.equal(r.enoughInfo, false)
  assert.ok(r.tier0Score < 50 && deep(r) < 50, `${r.tier0Score} / ${deep(r)}`)
})

test('a dealbreaker pair never scores high, however well everything else fits', () => {
  // Identical in every way, but she rules out smokers and he smokes.
  const smoker = { ...HOMEBODY, habitTags: ['reader', 'early_riser', 'cigarette_smoker', 'meditates'] }
  const r = score(man(smoker), woman({ ...HOMEBODY, dealbreakers: ['cigarette_smoker'] }))
  assert.deepEqual(r.triggeredDealbreakers, ['cigarette_smoker'])
  assert.ok(r.tier0Score <= DEALBREAKER_CAP, `Tier 0 ${r.tier0Score}`)
  assert.ok(deep(r) <= DEALBREAKER_CAP, `Deep Fit ${deep(r)}`)
  assert.ok(r.score <= DEALBREAKER_CAP, `headline ${r.score}`)
  assert.ok(r.tier1!.directions.ab <= DEALBREAKER_CAP && r.tier1!.directions.ba <= DEALBREAKER_CAP, 'a direction above the cap')
  assert.equal(r.tier1!.archetype, null, 'no archetype on a dealbreaker pair')
})

test('orientation mismatch scores 0', () => {
  const r = score(man(HOMEBODY), woman({ ...HOMEBODY, attractedTo: ['women'] }))
  assert.equal(r.score, 0)
  assert.equal(r.tier0Score, 0)
  assert.equal(deep(r), 0)
})

// Isabella (zbot-w-005) — the 99.77 → "100%" case. Her body-type preference
// fit him (formerly ×3); nothing else lined up.
const ISABELLA = woman({
  age: 32, ageMin: 30, ageMax: 40, intent: 'open', bodyType: 'average', heightCm: 158,
  lifestyleTags: ['creative', 'homebody', 'foodie'], habitTags: ['reader', 'cat_person', 'coffee_addict', 'cook', 'meditates'],
  drinkingHabit: 'socially', religion: 'catholic', politicalView: 'center_left',
  personalityTraits: ['intellectual', 'empathetic', 'genuine', 'sarcastic'], relationshipValues: ['communication', 'loyalty', 'humor'],
  weekendVibes: ['slow_mornings', 'cook_something_good', 'recharge_solo'],
  loveLangGive: ['words_of_affirmation', 'acts_of_service'], loveLangReceive: ['quality_time', 'words_of_affirmation'],
  parentalCurrent: 'no_kids', parentalIntent: 'open_to_more', conflictStyle: 'process_first', togethernessStyle: 'separate_plus_deep', stressResponse: 'get_quiet',
  dealbreakers: ['different_politics'], seekingBodyTypes: ['average', 'athletic', 'slim'],
})

// He fits her body-type preference and shares her intent and age range —
// real positives — but little else. Not a Strong fit, nowhere near 100.
test('meeting one physical preference no longer makes a near-perfect match', () => {
  const r = score(man({ ...NIGHT_OWL, intent: 'open', bodyType: 'athletic', heightCm: 185, politicalView: 'apolitical' }), ISABELLA)
  assert.ok(deep(r) < 75, `Deep Fit ${deep(r)}`)
  assert.ok(r.tier0Score < 75, `Tier 0 ${r.tier0Score}`)
})

// ─── Population ─────────────────────────────────────────────────────────────

const POP = (() => {
  const rnd = rng(7)
  return Array.from({ length: 12000 }, () => score(person(rnd, 'man', { blankShare: 0.1, dealbreakers: true }), person(rnd, 'woman', { blankShare: 0.1, dealbreakers: true })))
})()

test('every score is within 0–100', () => {
  for (const r of POP) {
    assert.ok(r.tier0Score >= 0 && r.tier0Score <= 100, `Tier 0 ${r.tier0Score}`)
    assert.ok(deep(r) >= 0 && deep(r) <= 100, `Deep Fit ${deep(r)}`)
  }
})

test('no dealbreaker pair in the population scores above the cap', () => {
  const triggered = POP.filter((r) => r.triggeredDealbreakers.length > 0)
  assert.ok(triggered.length > 500, `only ${triggered.length} dealbreaker pairs`)
  for (const r of triggered) {
    assert.ok(r.score <= DEALBREAKER_CAP && r.tier0Score <= DEALBREAKER_CAP && deep(r) <= DEALBREAKER_CAP, `${r.score} / ${r.tier0Score} / ${deep(r)} with ${r.triggeredDealbreakers}`)
  }
})

test('people who skipped the questions are never "enough info"', () => {
  const rnd = rng(11)
  for (let i = 0; i < 500; i++) {
    const r = score(person(rnd, 'man', { blankShare: 1 }), person(rnd, 'woman'))
    assert.equal(r.enoughInfo, false)
    assert.ok(r.tier0Score < 50 && deep(r) < 50, `${r.tier0Score} / ${deep(r)}`)
  }
})

// Calibration is judged on realistic profiles: every compatible pair of the
// curated profiles (test/fixtures/bots.json) — the population the curves
// were fitted on. Random profiles align less and would read low.
const BOTS = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/bots.json'), 'utf8')) as Profile[] // from .test-build/test
const REAL = (() => {
  const out: ReturnType<typeof score>[] = []
  for (let i = 0; i < BOTS.length; i++) {
    for (let j = i + 1; j < BOTS.length; j++) {
      const r = score(BOTS[i], BOTS[j])
      if (r.raw.tier0 > 0) out.push(r)
    }
  }
  return out
})()

for (const [name, pick] of [['Tier 0', (r: ReturnType<typeof score>) => r.tier0Score], ['Deep Fit', deep]] as const) {
  test(`${name}: calibrated spread on realistic profiles (median ≈ 55, 95+ under 1%, Strong fit 10–20%)`, () => {
    const shown = REAL.filter((r) => r.enoughInfo && !r.triggeredDealbreakers.length).map(pick).sort((a, b) => a - b)
    assert.ok(shown.length > 200, `only ${shown.length} pairs`)
    const median = quantile(shown, 0.5)
    const share = (min: number) => shown.filter((x) => x >= min).length / shown.length
    assert.ok(median >= 50 && median <= 60, `median ${median}`)
    assert.ok(share(95) < 0.01, `95+: ${(share(95) * 100).toFixed(2)}%`)
    assert.ok(share(75) >= 0.1 && share(75) <= 0.2, `75+: ${(share(75) * 100).toFixed(1)}%`)
  })
}

test('realistic dealbreaker pairs never score above the cap', () => {
  const triggered = REAL.filter((r) => r.triggeredDealbreakers.length > 0)
  assert.ok(triggered.length > 30, `only ${triggered.length}`)
  for (const r of triggered) assert.ok(r.score <= DEALBREAKER_CAP && r.tier0Score <= DEALBREAKER_CAP && deep(r) <= DEALBREAKER_CAP, `${r.score} / ${r.tier0Score} / ${deep(r)}`)
})
