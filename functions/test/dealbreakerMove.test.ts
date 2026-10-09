// Dealbreakers move from seekingPreferences/prefs (where older web builds
// saved them and scoring never looked) to private/matching: what the
// migration does with each account's old list, and that the editor's values
// are the keys scoring checks. The migration itself runs in e2e spec 39.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { cleanDealbreakers, dealbreakersInEffect, planDealbreakerMove } from '../src/dealbreakerMove'
import { DEALBREAKER_LABELS } from '../src/shared/profile'
import { calculateSparkScore } from '../src/legacy/scoring'
import type { UserDoc } from '../src/legacy/types'

test('the old list: scoring keys only, sorted without repeats; the retired enum and junk are dropped and counted', () => {
  assert.deepEqual(cleanDealbreakers(['vaper', 'heavy_drinker', 'vaper']), { value: ['heavy_drinker', 'vaper'], dropped: 0 })
  assert.deepEqual(cleanDealbreakers(['smoker', 'no_job', 'different_religion', 7, '']), { value: ['different_religion'], dropped: 4 })
  assert.deepEqual(cleanDealbreakers([]), { value: [], dropped: 0 })
  assert.deepEqual(cleanDealbreakers(null), { value: [], dropped: 0 })
  assert.deepEqual(cleanDealbreakers('vaper'), { value: [], dropped: 1 })
})

test('in effect: private/matching\'s list, else the public doc\'s old copy (null in private/matching counts as set)', () => {
  assert.deepEqual(dealbreakersInEffect({ dealbreakers: ['vaper'] }, { dealbreakers: ['heavy_drinker'] }), ['vaper'])
  assert.deepEqual(dealbreakersInEffect({}, { dealbreakers: ['heavy_drinker'] }), ['heavy_drinker'])
  assert.equal(dealbreakersInEffect({ dealbreakers: null }, { dealbreakers: ['heavy_drinker'] }), null)
  assert.equal(dealbreakersInEffect(undefined, undefined), undefined)
})

test('nothing in effect (absent, null, []): copied as a first value', () => {
  for (const matching of [undefined, {}, { dealbreakers: null }, { dealbreakers: [] }]) {
    assert.deepEqual(planDealbreakerMove(['vaper', 'cigarette_smoker'], matching, {}), { action: 'copy', value: ['cigarette_smoker', 'vaper'], dropped: 0 })
  }
  // The public doc's old copy, when empty, doesn't count either.
  assert.equal(planDealbreakerMove(['vaper'], {}, { dealbreakers: [] }).action, 'copy')
  // Invalid values don't travel.
  assert.deepEqual(planDealbreakerMove(['smoker', 'vaper'], {}, {}), { action: 'copy', value: ['vaper'], dropped: 1 })
})

test('the same list in effect (any order): identical; a different one: conflict, kept', () => {
  assert.deepEqual(planDealbreakerMove(['vaper', 'heavy_drinker'], { dealbreakers: ['heavy_drinker', 'vaper'] }, {}), { action: 'identical', dropped: 0 })
  assert.deepEqual(planDealbreakerMove(['vaper'], { dealbreakers: ['heavy_drinker'] }, {}), { action: 'conflict', stamped: false, dropped: 0 })
  // In effect through the public doc's old copy.
  assert.equal(planDealbreakerMove(['vaper'], {}, { dealbreakers: ['vaper'] }).action, 'identical')
  assert.equal(planDealbreakerMove(['vaper'], {}, { dealbreakers: ['heavy_drinker'] }).action, 'conflict')
})

test('cleared on purpose under the 30-day limit (stamped): kept, a conflict', () => {
  assert.deepEqual(
    planDealbreakerMove(['vaper'], { dealbreakers: [], fieldChangedAt: { dealbreakers: { seconds: 1 } } }, {}),
    { action: 'conflict', stamped: true, dropped: 0 },
  )
  // A stamp on another field doesn't matter.
  assert.equal(planDealbreakerMove(['vaper'], { fieldChangedAt: { religion: { seconds: 1 } } }, {}).action, 'copy')
})

test('nothing valid in the old list: empty (only removed)', () => {
  assert.deepEqual(planDealbreakerMove([], {}, {}), { action: 'empty', dropped: 0 })
  assert.deepEqual(planDealbreakerMove(['smoker', 'no_photo'], {}, {}), { action: 'empty', dropped: 2 })
  assert.deepEqual(planDealbreakerMove(null, { dealbreakers: ['vaper'] }, {}), { action: 'empty', dropped: 0 })
})

test('the web editor offers the keys scoring knows (no mapping needed), and each one can trigger', () => {
  const web = readFileSync(new URL('../../../src/types/profile.ts', `file://${__dirname}/`), 'utf8')
  const block = /export type Dealbreaker =([^]*?)\n\n/.exec(web)?.[1] ?? ''
  const webKeys = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(webKeys, Object.keys(DEALBREAKER_LABELS).sort())
  // A partner that trips every dealbreaker.
  const partner = {
    habitTags: ['cigarette_smoker', 'vaper'], drinkingHabit: 'regularly', parentalCurrent: 'has_kids', parentalIntent: 'wants_more',
    openTo: ['casual'], religion: 'jewish', politicalView: 'democrat',
  }
  const childFree = { ...partner, parentalIntent: 'doesnt_want_any' }
  for (const key of webKeys) {
    const self = { dealbreakers: [key], religion: 'christian', politicalView: 'republican' }
    const target = key.includes('doesnt_want') ? childFree : partner
    assert.deepEqual(calculateSparkScore(self as unknown as UserDoc, target as unknown as UserDoc).triggeredDealbreakers, [key], key)
  }
})
