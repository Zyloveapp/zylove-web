// T&S Phase 3 — when "Share contact" unlocks, and the request-timing reasons.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { UNLOCK_MESSAGES, unlockedAt } from '../src/contactExchange'
import { FLAG_AT, featuresOf, scoreFeatures } from '../src/trustScore'

const m = (senderId: string, sentAt: number, o: Record<string, unknown> = {}) => ({ senderId, sentAt, messageType: 'text', nonce: 'n', ...o })

test('unlock: both people need 3 real messages in this match generation', () => {
  assert.equal(UNLOCK_MESSAGES, 3)
  const both = [m('a', 1), m('b', 2), m('a', 3), m('b', 4), m('a', 5), m('b', 9)]
  assert.equal(unlockedAt(both, ['a', 'b'], 0), 9) // Bea's 3rd message unlocks it
  assert.equal(unlockedAt(both.slice(0, 5), ['a', 'b'], 0), null) // Bea has only 2
  // One person talking a lot isn't enough.
  assert.equal(unlockedAt([m('a', 1), m('a', 2), m('a', 3), m('a', 4), m('b', 5)], ['a', 'b'], 0), null)
  // System notes, consent codes and contact cards don't count; photos do.
  const extras = [m('a', 1), m('a', 2), m('a', 3), m('b', 4, { nonce: 'system' }), m('b', 5, { messageType: 'consent_request' }), m('b', 6, { messageType: 'contact_card' }), m('b', 7, { messageType: 'photo' }), m('b', 8), m('b', 9)]
  assert.equal(unlockedAt(extras, ['a', 'b'], 0), 9)
  // A previous match between the same two people doesn't count.
  assert.equal(unlockedAt(both, ['a', 'b'], 5), null)
})

test('contact-request timing: counts only, weak on their own, both together flag with other signals', () => {
  const now = Date.now()
  const recent = (n: number, fast: boolean) => Array.from({ length: n }, (_, i) => ({ at: now - i * 60_000, fast }))
  const rush = featuresOf({ signals: { contactRequests: { total: 6, recent: recent(6, false) } }, now })
  assert.equal(rush.contactRequests24h, 6)
  const r = scoreFeatures(rush, null)
  assert.equal(r.reasons[0].key, 'contact_rush')
  assert.ok(r.score < FLAG_AT)
  const fast = scoreFeatures(featuresOf({ signals: { contactRequests: { recent: recent(3, true) } }, now }), null)
  assert.equal(fast.reasons[0].key, 'contact_fast')
  assert.ok(fast.score < FLAG_AT)
  // Old requests drop off.
  const old = featuresOf({ signals: { contactRequests: { recent: [{ at: now - 8 * 864e5, fast: true }] } }, now })
  assert.deepEqual([old.contactRequests24h, old.contactFastAfterUnlock7d], [0, 0])
})
