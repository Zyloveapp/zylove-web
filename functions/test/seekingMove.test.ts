// Body-type, trait and height preferences move from seekingPreferences/prefs
// (where older web builds saved them and scoring never looked) to
// private/matching: what the migration does with each account's old values,
// and that the editor's values are the keys and units scoring checks. The
// migration itself runs in e2e spec 44.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { cleanKeys, heightRange, planSeekingMove } from '../src/seekingMove'
import { BODY_TYPE_LABELS, SEEKING_TRAIT_LABELS } from '../src/shared/profile'
import { calculateSparkScore } from '../src/legacy/scoring'
import type { UserDoc } from '../src/legacy/types'

const KNOWN = new Set(['slim', 'athletic'])
const RANGE = { seekingHeightMinCm: 170, seekingHeightMaxCm: 190 }

test('lists: known keys only, without repeats, order kept; junk dropped and counted', () => {
  assert.deepEqual(cleanKeys(['athletic', 'slim', 'athletic'], KNOWN), { value: ['athletic', 'slim'], dropped: 0 })
  assert.deepEqual(cleanKeys(['slim', 'tall', 7, ''], KNOWN), { value: ['slim'], dropped: 3 })
  assert.deepEqual(cleanKeys(null, KNOWN), { value: [], dropped: 0 })
  assert.deepEqual(cleanKeys('slim', KNOWN), { value: [], dropped: 1 })
})

test('height: both ends, 100–250 cm, min ≤ max (whole cm); else none', () => {
  assert.deepEqual(heightRange(170, 190), RANGE)
  assert.deepEqual(heightRange(170.4, 170.4), { seekingHeightMinCm: 170, seekingHeightMaxCm: 170 })
  for (const [min, max] of [[190, 170], [170, undefined], [undefined, 190], [50, 190], [170, 400], ['170', 190], [NaN, 190], [0, 0]]) {
    assert.equal(heightRange(min, max), null, `${min}–${max}`)
  }
})

test('nothing in effect (absent, null, [], half a range): each field copied', () => {
  const old = { seekingBodyTypes: ['athletic', 'slim'], seekingTraits: ['kind', 'funny'], ...RANGE, seekingHeightNoPreference: false }
  for (const matching of [undefined, {}, { seekingBodyTypes: null, seekingTraits: [], seekingHeightMinCm: 160 }]) {
    assert.deepEqual(planSeekingMove(old, matching, {}), {
      seekingBodyTypes: { action: 'copy', value: { seekingBodyTypes: ['athletic', 'slim'] }, dropped: 0 },
      seekingTraits: { action: 'copy', value: { seekingTraits: ['kind', 'funny'] }, dropped: 0 },
      seekingHeight: { action: 'copy', value: RANGE, dropped: 0 },
    })
  }
})

test('the same value in effect (any order): identical; a different one: conflict, the private one kept', () => {
  const old = { seekingBodyTypes: ['athletic', 'slim'], seekingTraits: ['kind'], ...RANGE }
  assert.deepEqual(planSeekingMove(old, { seekingBodyTypes: ['slim', 'athletic'], seekingTraits: ['kind'], ...RANGE }, {}), {
    seekingBodyTypes: { action: 'identical', dropped: 0 },
    seekingTraits: { action: 'identical', dropped: 0 },
    seekingHeight: { action: 'identical', dropped: 0 },
  })
  assert.deepEqual(planSeekingMove(old, { seekingBodyTypes: ['curvy'], seekingTraits: ['funny'], seekingHeightMinCm: 150, seekingHeightMaxCm: 190 }, {}), {
    seekingBodyTypes: { action: 'conflict', dropped: 0 },
    seekingTraits: { action: 'conflict', dropped: 0 },
    seekingHeight: { action: 'conflict', dropped: 0 },
  })
  // Each field on its own: one conflicts, another is copied.
  const mixed = planSeekingMove(old, { seekingBodyTypes: ['curvy'] }, {})
  assert.equal(mixed.seekingBodyTypes.action, 'conflict')
  assert.equal(mixed.seekingTraits.action, 'copy')
  // In effect through the public doc's old copy (pre-Stage 3); private/matching wins over it.
  assert.equal(planSeekingMove(old, {}, { seekingTraits: ['kind'] }).seekingTraits.action, 'identical')
  assert.equal(planSeekingMove(old, {}, { seekingTraits: ['funny'] }).seekingTraits.action, 'conflict')
  assert.equal(planSeekingMove(old, { seekingTraits: ['kind'] }, { seekingTraits: ['funny'] }).seekingTraits.action, 'identical')
  assert.equal(planSeekingMove(old, {}, RANGE).seekingHeight.action, 'identical')
})

test('nothing valid, or "no preference": empty (only removed); a field not there: absent', () => {
  assert.deepEqual(planSeekingMove({ seekingBodyTypes: [], seekingTraits: ['nice', 'kind'] }, {}, {}), {
    seekingBodyTypes: { action: 'empty', dropped: 0 },
    seekingTraits: { action: 'copy', value: { seekingTraits: ['kind'] }, dropped: 1 },
    seekingHeight: { action: 'absent' },
  })
  // 'prefer_not_to_say' isn't something the editor lets you look for.
  assert.deepEqual(planSeekingMove({ seekingBodyTypes: ['prefer_not_to_say', 'tall'] }, {}, {}).seekingBodyTypes, { action: 'empty', dropped: 2 })
  assert.deepEqual(planSeekingMove({ seekingHeightMinCm: 190, seekingHeightMaxCm: 170 }, {}, {}).seekingHeight, { action: 'empty', dropped: 1 })
  assert.deepEqual(planSeekingMove({ ...RANGE, seekingHeightNoPreference: true }, {}, {}).seekingHeight, { action: 'empty', dropped: 0 })
  assert.deepEqual(planSeekingMove(undefined, {}, {}).seekingTraits, { action: 'absent' })
  // An invalid old value never replaces a private one either.
  assert.equal(planSeekingMove({ seekingTraits: ['nice'] }, { seekingTraits: ['kind'] }, {}).seekingTraits.action, 'empty')
})

test('the web editor saves the keys and units scoring knows (no mapping needed), and a preference moves the viewer\'s physical bar', () => {
  const web = readFileSync(new URL('../../../src/types/profile.ts', `file://${__dirname}/`), 'utf8')
  const union = (name: string) => [...(new RegExp(`export type ${name} =([^]*?)\\n\\n`).exec(web)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(union('BodyType'), Object.keys(BODY_TYPE_LABELS).sort())
  assert.deepEqual(union('SeekingTrait'), Object.keys(SEEKING_TRAIT_LABELS).sort())
  // Heights: the web converts feet/inches to whole cm, as heightCm is stored.
  assert.match(web, /export function feetInchesToCm\(feet: number, inches: number\): number \{\n\s+return Math\.round\(\(feet \* 12 \+ inches\) \* 2\.54\)/)

  // Scoring reads them from the (merged) private profile: the viewer's own
  // direction goes from none to a value once they're in effect.
  const viewer = { genderIdentity: 'woman', attractedTo: ['men'], age: 30, heightCm: 165, bodyType: 'curvy' }
  const target = { genderIdentity: 'man', attractedTo: ['women'], age: 31, heightCm: 188, bodyType: 'athletic' }
  const run = (v: object) => calculateSparkScore(v as unknown as UserDoc, target as unknown as UserDoc).physicalDirections.ab
  assert.equal(run(viewer), null)
  assert.equal(run({ ...viewer, seekingBodyTypes: ['athletic'], seekingHeightMinCm: 180, seekingHeightMaxCm: 200 }), 100)
  assert.equal(run({ ...viewer, seekingBodyTypes: ['slim'], seekingHeightMinCm: 150, seekingHeightMaxCm: 170 }), 25)
})
