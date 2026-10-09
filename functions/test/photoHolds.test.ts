// F-081 — which photo holds are kept for review whatever the owner does:
// content flags and blocklist matches; not a missing face or a moderation error.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { holdReason, isKeptHold } from '../src/photoHolds'

test('content flags and blocklist matches are kept; other holds are not', () => {
  assert.equal(isKeptHold({ sexual_activity: 0.7, exceeded: ['sexual_activity'] }), true)
  assert.equal(isKeptHold({ blocklist: true }), true)
  assert.equal(isKeptHold({ noFace: true }), false)
  assert.equal(isKeptHold({ error: 'moderation_error' }), false)
  assert.equal(isKeptHold({ sexual_activity: 0.1, exceeded: [] }), false)
  for (const r of [null, undefined, 'x', 1]) assert.equal(isKeptHold(r), false)
})

test('a hold read back from photoHolds alone', () => {
  assert.deepEqual(holdReason({ kind: 'content', reason: { gore: 0.9, exceeded: ['gore'] } }), { gore: 0.9, exceeded: ['gore'] })
  assert.deepEqual(holdReason({ kind: 'blocklist', match: { uid: 'z' }, more: 1, distance: 2 }), { blocklist: true, match: { uid: 'z' }, more: 1, distance: 2 })
  // Blocklist holds from before F-081 have no kind.
  assert.deepEqual(holdReason({ match: null }), { blocklist: true, match: null, more: 0, distance: null })
})
