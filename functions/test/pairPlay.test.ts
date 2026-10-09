// Play pair scores (playPairData): a re-score with no archetype clears the
// stored label. setPlayScores merges, and the merge used to omit tier1Play,
// so the old label stayed (report 2026-10-09 1340: 12 pairs).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { FieldValue, type DocumentData } from 'firebase-admin/firestore'
import { playFields, playScoresMergeFields, playScoresWrite, playTapAnswer } from '../src/pairPlay'

// What Firestore's set leaves (server timestamps don't matter here):
// - { merge: true }: maps merge key by key, all the way down;
// - { mergeFields }: each listed top-level field replaced whole;
// FieldValue.delete() removes its field either way.
const isDelete = (v: unknown) => v instanceof FieldValue && v.isEqual(FieldValue.delete())
const isMap = (v: unknown): v is DocumentData => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof FieldValue)
function deepMerged(stored: DocumentData, write: DocumentData): DocumentData {
  const out: DocumentData = { ...stored }
  for (const [k, v] of Object.entries(write)) {
    if (isDelete(v)) delete out[k]
    else if (isMap(v) && isMap(out[k])) out[k] = deepMerged(out[k], v)
    else out[k] = v
  }
  return out
}
function fieldsMerged(stored: DocumentData, write: DocumentData, fields: string[]): DocumentData {
  const out: DocumentData = { ...stored }
  for (const k of fields) {
    if (!(k in write) || isDelete(write[k])) delete out[k]
    else out[k] = write[k]
  }
  return out
}
// What setPlayScores leaves.
const merged = (stored: DocumentData, write: DocumentData) => fieldsMerged(stored, write, playScoresMergeFields(write))

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

// The 2026-10-09 deploy: setPlayScores merged with { merge: true }, so the
// stored tier1Play (and playBreakdown) kept keys the trimmed value no longer
// had. The model above was top-level only and missed it.
test('a re-score replaces tier1Play and playBreakdown whole — no old keys left; likedBy kept', () => {
  const stored = {
    users: ['a', 'b'], likedBy: ['a'], playScore: 70,
    playBreakdown: { nonNegotiables: 80, oldCategory: 5 },
    tier1Play: { archetype: { id: 'intense_pair', label: 'Intense Pair', copy: 'x', confidence: 0.8 }, combinedScore: 70.3, asymmetryGap: 3, dataConfidence: 0.9 },
  }
  const next = { archetype: { id: 'same_frequency', label: 'Same Frequency', copy: 'y', confidence: 0.7 }, combinedScore: 80.4, asymmetryGap: 0, dataConfidence: 1 }
  const write = playScoresWrite('a', 'b', { ...playFields(80, { nonNegotiables: 90 }, next), engineVersion: 3 })
  // The old write mode leaves the raw keys behind…
  const before = deepMerged(stored, write)
  assert.equal(before.tier1Play.asymmetryGap, 3)
  assert.equal(before.tier1Play.archetype.confidence, 0.8)
  assert.equal(before.playBreakdown.oldCategory, 5)
  // …what setPlayScores writes now doesn't.
  const after = merged(stored, write)
  assert.deepEqual(after.tier1Play, { archetype: { id: 'same_frequency', label: 'Same Frequency', copy: 'y' }, combinedScore: 80 })
  assert.deepEqual(after.playBreakdown, { nonNegotiables: 90 })
  assert.deepEqual(after.likedBy, ['a'])
  assert.equal(after.engineVersion, 3)
  // And no archetype now: tier1Play goes.
  assert.equal('tier1Play' in merged(stored, playScoresWrite('a', 'b', playFields(60, {}, null))), false)
  assert.ok(playScoresMergeFields(write).includes('tier1Play') && !playScoresMergeFields(write).includes('likedBy'))
})
