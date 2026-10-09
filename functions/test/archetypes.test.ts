// Deep Fit archetypes: every predicate, and the picker (strongest fit wins,
// ties to the more specific, nothing forced below MIN_CONFIDENCE).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { ALL_FACET_IDS } from '../src/legacy/tier1/facets'
import type { FacetVector } from '../src/legacy/tier1/facetProfile'
import { MIN_CONFIDENCE, PLAY_ARCHETYPES, SPARK_ARCHETYPES } from '../src/legacy/tier1/archetypes'
import { matchPlayArchetype, matchSparkArchetype, pickStrongest } from '../src/legacy/tier1/archetypeMatcher'

type F = Partial<FacetVector>
const vec = (o: F = {}): FacetVector => ({ ...Object.fromEntries(ALL_FACET_IDS.map((k) => [k, 0.5])), ...o }) as FacetVector
const spark = (id: string) => SPARK_ARCHETYPES.find((d) => d.id === id)!
const play = (id: string) => PLAY_ARCHETYPES.find((d) => d.id === id)!
const fires = (id: string, a: F, b: F = a) => spark(id).predicate(vec(a), vec(b))

// Each Spark archetype: a pair that clearly fits, and the same pair with one
// facet just under its bar.
const SPARK_CASES: { id: string; fit: F; under: F }[] = [
  {
    id: 'the_builders',
    fit: { ambition_drive: 0.8, conscientiousness: 0.8, family_orientation: 0.8, commitment_orientation: 0.8 },
    under: { ambition_drive: 0.8, conscientiousness: 0.8, family_orientation: 0.6, commitment_orientation: 0.8 },
  },
  {
    id: 'family_first',
    fit: { family_orientation: 0.8, commitment_orientation: 0.8, nurturing_impulse: 0.85 },
    under: { family_orientation: 0.8, commitment_orientation: 0.8, nurturing_impulse: 0.7 },
  },
  {
    id: 'kinetic_match',
    fit: { extraversion_social: 0.8, high_arousal_preference: 0.8, openness_to_novelty: 0.8, spontaneity: 0.8 },
    under: { extraversion_social: 0.58, high_arousal_preference: 0.8, openness_to_novelty: 0.8, spontaneity: 0.8 },
  },
  {
    id: 'adventure_partners',
    fit: { openness_to_novelty: 0.8, spontaneity: 0.8, risk_tolerance: 0.7 },
    under: { openness_to_novelty: 0.8, spontaneity: 0.8, risk_tolerance: 0.5 },
  },
  {
    id: 'quiet_depth',
    fit: { extraversion_social: 0.2, emotional_depth: 0.85, self_awareness: 0.85 },
    under: { extraversion_social: 0.6, emotional_depth: 0.85, self_awareness: 0.85 },
  },
  {
    id: 'deep_talkers',
    fit: { verbal_expressiveness: 0.85, emotional_depth: 0.85, conflict_directness: 0.75 },
    under: { verbal_expressiveness: 0.7, emotional_depth: 0.85, conflict_directness: 0.75 },
  },
  {
    id: 'steady_hearts',
    fit: { commitment_orientation: 0.8, emotional_stability: 0.8, emotional_availability: 0.85 },
    under: { commitment_orientation: 0.8, emotional_stability: 0.6, emotional_availability: 0.85 },
  },
  {
    id: 'curious_minds',
    fit: { intellectual_curiosity: 0.8, openness_to_novelty: 0.8, aesthetic_sensitivity: 0.8 },
    under: { intellectual_curiosity: 0.6, openness_to_novelty: 0.8, aesthetic_sensitivity: 0.8 },
  },
  {
    id: 'parallel_paths',
    fit: { personal_growth_focus: 0.8, ambition_drive: 0.8, self_awareness: 0.8, lifestyle_discipline: 0.8 },
    under: { personal_growth_focus: 0.8, ambition_drive: 0.8, self_awareness: 0.8, lifestyle_discipline: 0.6 },
  },
]

for (const c of SPARK_CASES) {
  test(`spark ${c.id}: fires on a clear fit, not just under the bar`, () => {
    const yes = fires(c.id, c.fit)
    assert.ok(yes >= MIN_CONFIDENCE, `${c.id} fit → ${yes}`)
    assert.equal(fires(c.id, c.under), 0, `${c.id} under the bar`)
    // Both people must fit: one side alone isn't the pattern.
    assert.equal(fires(c.id, c.fit, {}), 0, `${c.id} one-sided`)
  })
}

test('every Spark archetype has a test case (except the shape-based ones below)', () => {
  const tested = new Set([...SPARK_CASES.map((c) => c.id), 'grounded_and_free', 'complementary_yin_yang', 'two_peas'])
  for (const d of SPARK_ARCHETYPES) assert.ok(tested.has(d.id), `untested: ${d.id}`)
})

test('parallel_paths no longer fires on the old three facets at 0.55–0.6', () => {
  const old = { personal_growth_focus: 0.6, ambition_drive: 0.6, self_awareness: 0.6 }
  assert.equal(fires('parallel_paths', old), 0)
  assert.equal(fires('parallel_paths', { ...old, lifestyle_discipline: 0.9 }), 0) // still under 0.65 on three
})

test('grounded_and_free: one grounded, one free, values aligned', () => {
  const grounded = { routine_preference: 0.8, lifestyle_discipline: 0.8, integrity_valued: 0.7 }
  const free = { openness_to_novelty: 0.8, spontaneity: 0.8, integrity_valued: 0.7 }
  assert.ok(fires('grounded_and_free', grounded, free) >= MIN_CONFIDENCE)
  assert.equal(fires('grounded_and_free', grounded, grounded), 0, 'both grounded')
  assert.equal(fires('grounded_and_free', { ...grounded, ...free }, free), 0, 'one side both')
  const apartA = { integrity_valued: 0.1, personal_growth_focus: 0.1, spiritual_openness: 0.1 }
  const apartB = { integrity_valued: 0.9, personal_growth_focus: 0.9, spiritual_openness: 0.9 }
  assert.equal(fires('grounded_and_free', { ...grounded, ...apartA }, { ...free, ...apartB }), 0, 'values apart')
})

test('complementary_yin_yang: values aligned, styles apart', () => {
  const a = { extraversion_social: 0.9, risk_tolerance: 0.9, conflict_directness: 0.9 }
  const b = { extraversion_social: 0.2, risk_tolerance: 0.2, conflict_directness: 0.2 }
  assert.ok(fires('complementary_yin_yang', a, b) >= MIN_CONFIDENCE)
  assert.equal(fires('complementary_yin_yang', a, a), 0, 'styles the same')
  assert.equal(fires('complementary_yin_yang', { ...a, integrity_valued: 0.1, spiritual_openness: 0.1 }, { ...b, integrity_valued: 0.9, spiritual_openness: 0.9 }), 0, 'values apart')
})

test('two_peas: both active, close everywhere, shared values', () => {
  const active: F = Object.fromEntries(ALL_FACET_IDS.slice(0, 12).map((k) => [k, 0.8]))
  const p = { ...active, integrity_valued: 0.8, personal_growth_focus: 0.8, spiritual_openness: 0.8 }
  assert.ok(fires('two_peas', p, p) >= MIN_CONFIDENCE)
  assert.equal(fires('two_peas', {}, {}), 0, 'both neutral is not "the same language"')
  const apart: F = Object.fromEntries(ALL_FACET_IDS.map((k) => [k, 0.2]))
  assert.equal(fires('two_peas', p, apart), 0)
})

// ─── The picker ──────────────────────────────────────────────────────────────

test('picker: the strongest fit wins, not the first in the list', () => {
  // Builders (first in the list) at a bare fit; Family First far stronger.
  const a = { ambition_drive: 0.66, conscientiousness: 0.66, family_orientation: 1, commitment_orientation: 1, nurturing_impulse: 1 }
  assert.ok(fires('the_builders', a) > 0)
  assert.equal(matchSparkArchetype(vec(a), vec(a))?.id, 'family_first')
})

test('picker: a tie goes to the more specific (earlier) archetype', () => {
  const defs = [
    { id: 'first', label: 'First', copy: '' },
    { id: 'second', label: 'Second', copy: '' },
  ]
  assert.equal(pickStrongest(defs, () => 0.8)?.id, 'first')
  assert.equal(pickStrongest(defs, (d) => (d.id === 'second' ? 0.9 : 0.8))?.id, 'second')
})

test('picker: nothing below MIN_CONFIDENCE is named (no forced label)', () => {
  const defs = [{ id: 'weak', label: 'Weak', copy: '' }]
  assert.equal(pickStrongest(defs, () => MIN_CONFIDENCE - 0.01), null)
  assert.equal(pickStrongest(defs, () => MIN_CONFIDENCE)?.id, 'weak')
  // All-neutral people, and the "everyone's a bit above average" profile.
  assert.equal(matchSparkArchetype(vec(), vec()), null)
  const typical: F = Object.fromEntries(ALL_FACET_IDS.map((k) => [k, 0.58]))
  assert.equal(matchSparkArchetype(vec(typical), vec(typical)), null)
})

test('picker: confidence is graded, so stronger signal ranks higher', () => {
  const at = (v: number) => fires('steady_hearts', { commitment_orientation: v, emotional_stability: v, emotional_availability: Math.max(v, 0.75) })
  assert.ok(at(0.9) > at(0.8) && at(0.8) > at(0.7), `${at(0.7)} ${at(0.8)} ${at(0.9)}`)
  assert.ok(at(0.9) < 1)
})

// ─── Play ────────────────────────────────────────────────────────────────────

const playFires = (id: string, a: F, b: F = a, spice = true) => play(id).predicate(vec(a), vec(b), spice)

test('play intense_pair: spice-aligned and both at 0.75+; not at the old 0.55', () => {
  const hot = { sensuality: 0.85, physical_expressiveness: 0.85 }
  assert.ok(playFires('intense_pair', hot) >= MIN_CONFIDENCE)
  assert.equal(playFires('intense_pair', hot, hot, false), 0, 'spice not aligned')
  assert.equal(playFires('intense_pair', { sensuality: 0.7, physical_expressiveness: 0.7 }), 0)
})

test('play talkers_first: 0.75 on directness and words, 0.65 integrity; not at the old 0.65 words', () => {
  const t = { conflict_directness: 0.85, verbal_expressiveness: 0.85, integrity_valued: 0.8 }
  assert.ok(playFires('talkers_first', t) >= MIN_CONFIDENCE)
  assert.equal(playFires('talkers_first', { ...t, verbal_expressiveness: 0.7 }, t), 0, 'verbal under 0.75')
  assert.equal(playFires('talkers_first', { ...t, integrity_valued: 0.6 }, t), 0, 'integrity under 0.65')
})

test('play slow_burn: both sensual, neither chasing intensity or impulse', () => {
  const slow = { sensuality: 0.85, high_arousal_preference: 0.5, spontaneity: 0.5 }
  assert.ok(playFires('slow_burn', slow) >= MIN_CONFIDENCE)
  assert.equal(playFires('slow_burn', { ...slow, high_arousal_preference: 0.8 }, slow), 0, 'one chasing intensity')
  assert.equal(playFires('slow_burn', { ...slow, spontaneity: 0.8 }, slow), 0, 'one impulsive')
  assert.equal(playFires('slow_burn', { ...slow, sensuality: 0.7 }, slow), 0, 'sensuality under 0.75')
})

test('play fully_present: available, deep and sensual', () => {
  const f = { emotional_availability: 0.9, emotional_depth: 0.8, sensuality: 0.8 }
  assert.ok(playFires('fully_present', f) >= MIN_CONFIDENCE)
  assert.equal(playFires('fully_present', { ...f, emotional_availability: 0.75 }, f), 0)
  assert.equal(playFires('fully_present', { ...f, emotional_depth: 0.65 }, f), 0)
})

test('play playful_pair: both lead with fun', () => {
  const p = { playfulness: 0.8, spontaneity: 0.7 }
  assert.ok(playFires('playful_pair', p) >= MIN_CONFIDENCE)
  assert.equal(playFires('playful_pair', { ...p, playfulness: 0.6 }, p), 0)
  assert.equal(playFires('playful_pair', p, {}), 0, 'one-sided')
})

test('play wild_cards: both spontaneous and up for something new', () => {
  const w = { spontaneity: 0.8, openness_to_novelty: 0.8 }
  assert.ok(playFires('wild_cards', w) >= MIN_CONFIDENCE)
  assert.equal(playFires('wild_cards', { ...w, openness_to_novelty: 0.6 }, w), 0)
})

test('play same_frequency: shared signal on 3+ of the 5, not shared neutrality', () => {
  const p = { sensuality: 0.8, physical_expressiveness: 0.8, high_arousal_preference: 0.8, spontaneity: 0.8, playfulness: 0.8 }
  assert.ok(playFires('same_frequency', p) >= MIN_CONFIDENCE)
  assert.equal(playFires('same_frequency', p, p, false), 0, 'spice not aligned')
  // Two active facets and three neutral ones "agree" — that used to count.
  const quiet = { sensuality: 0.8, physical_expressiveness: 0.8 }
  assert.equal(playFires('same_frequency', quiet), 0)
})

test('play curious_and_willing: the fallback at MIN_CONFIDENCE', () => {
  const p = { sensuality: 0.8, physical_expressiveness: 0.8, high_arousal_preference: 0.8, spontaneity: 0.8, playfulness: 0.8 }
  const q = { ...p, high_arousal_preference: 0.2, spontaneity: 0.2 }
  assert.equal(playFires('curious_and_willing', p, q), MIN_CONFIDENCE)
  assert.equal(playFires('curious_and_willing', p, p), 0, 'everything aligned is not this')
})

test('every Play archetype has a test above', () => {
  const tested = new Set(['intense_pair', 'talkers_first', 'slow_burn', 'fully_present', 'playful_pair', 'wild_cards', 'same_frequency', 'curious_and_willing'])
  for (const d of PLAY_ARCHETYPES) assert.ok(tested.has(d.id), `untested: ${d.id}`)
})

test('play picker: strongest wins over list order; the fallback loses to any clear pattern', () => {
  // Talkers First (earlier) at a bare fit; Playful Pair (later) far stronger.
  const both = { conflict_directness: 0.76, verbal_expressiveness: 0.76, integrity_valued: 0.66, playfulness: 0.95, spontaneity: 0.95 }
  assert.ok(playFires('talkers_first', both) > 0)
  assert.equal(matchPlayArchetype(vec(both), vec(both), false)?.id, 'playful_pair')
  // A clear pattern beats Curious & Willing even when both apply.
  const a = { playfulness: 0.9, spontaneity: 0.9, sensuality: 0.8, physical_expressiveness: 0.8, high_arousal_preference: 0.8 }
  const b = { playfulness: 0.9, spontaneity: 0.9, sensuality: 0.8, physical_expressiveness: 0.2, high_arousal_preference: 0.2 }
  assert.equal(playFires('curious_and_willing', a, b), MIN_CONFIDENCE)
  assert.equal(matchPlayArchetype(vec(a), vec(b), true)?.id, 'playful_pair')
  assert.equal(matchPlayArchetype(vec(), vec(), false), null)
})
