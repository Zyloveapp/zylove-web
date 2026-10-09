// Play pair scores (playPairData): a re-score with no archetype clears the
// stored label. setPlayScores merges, and the merge used to omit tier1Play,
// so the old label stayed (report 2026-10-09 1340: 12 pairs).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { FieldValue, type DocumentData } from 'firebase-admin/firestore'
import { playFields, playScoresWrite, playTapAnswer } from '../src/pairPlay'

// What a { merge: true } set leaves: the write's fields over the stored ones,
// FieldValue.delete() removing its field (server timestamps don't matter here).
function merged(stored: DocumentData, write: DocumentData): DocumentData {
  const out: DocumentData = { ...stored }
  for (const [k, v] of Object.entries(write)) {
    if (v instanceof FieldValue && v.isEqual(FieldValue.delete())) delete out[k]
    else out[k] = v
  }
  return out
}

const label = { archetype: { id: 'intense_pair', label: 'Intense Pair', copy: 'x', confidence: 0.8 }, combinedScore: 70, asymmetryGap: 0, dataConfidence: 1 }

test('a pair that had a Play label and now has none ends with no tier1Play', () => {
  const stored = { users: ['a', 'b'], playScore: 70, playBreakdown: {}, tier1Play: label }
  const after = merged(stored, playScoresWrite('b', 'a', { ...playFields(72, { x: 1 }, null), engineVersion: 2 }))
  assert.equal('tier1Play' in after, false)
  assert.equal(after.playScore, 72)
  assert.deepEqual(after.users, ['a', 'b'])
})

test('a new Play label replaces the old one, in the public shape (F-098: no confidence or constant fields)', () => {
  const next = { archetype: { id: 'same_frequency', label: 'Same Frequency', copy: 'y', confidence: 0.7 }, combinedScore: 80.4, asymmetryGap: 0, dataConfidence: 1 }
  const after = merged({ tier1Play: label }, playScoresWrite('a', 'b', playFields(80, {}, next)))
  assert.deepEqual(after.tier1Play, { archetype: { id: 'same_frequency', label: 'Same Frequency', copy: 'y' }, combinedScore: 80 })
})

test('playFields itself stays free of write sentinels (onLike and onTap reuse it in memory)', () => {
  assert.equal('tier1Play' in playFields(50, {}, null), false)
})

// F-098: a Play tap is gated by plan as Spark is — the score for everyone,
// the breakdown for Spark+ (full), the archetype for Elite (deep) — and the
// archetype never carries its confidence (an old stored doc still does).
test('F-098: a Play tap answer by plan', () => {
  const stored = { playScore: 70, playBreakdown: { nonNegotiables: 80 }, tier1Play: label }
  const free = playTapAnswer(stored, { full: false, deep: false })
  assert.deepEqual(free.breakdown, {})
  assert.equal('playArchetype' in free, false)
  assert.equal(free.playScore, 70)
  assert.equal(free.locked, true)
  const sparkPlus = playTapAnswer(stored, { full: true, deep: false })
  assert.deepEqual(sparkPlus.breakdown, { play: { nonNegotiables: 80 } })
  assert.equal('playArchetype' in sparkPlus, false)
  assert.equal(sparkPlus.locked, false)
  const elite = playTapAnswer(stored, { full: true, deep: true })
  assert.deepEqual(elite.breakdown, { play: { nonNegotiables: 80 } })
  assert.deepEqual(elite.playArchetype, { id: 'intense_pair', label: 'Intense Pair', copy: 'x' })
  assert.ok(!JSON.stringify(elite).includes('confidence'))
  assert.equal('playArchetype' in playTapAnswer({ playScore: 50, playBreakdown: {} }, { full: true, deep: true }), false)
})
