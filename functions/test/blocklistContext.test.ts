// T&S Phase 5 follow-up — a blocklist hold's context in Photo review:
// closeness in plain words, the ban's reason, "and N more", and holds
// without context (from before) showing nothing extra.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { banWhy, closeness, matchView, reportCounts } from '../src/blocklistContext'

test('closeness: 0 exact, 1–4 very close, 5–8 similar', () => {
  assert.equal(closeness(0), 'Exact copy')
  for (const d of [1, 2, 3, 4]) assert.equal(closeness(d), 'Very close (edited/re-saved)')
  for (const d of [5, 6, 7, 8]) assert.equal(closeness(d), 'Similar')
})

test('reportCounts: one count per report per category', () => {
  assert.deepEqual(reportCounts([['scam'], ['scam', 'harassment'], ['scam', 'scam'], []]), { scam: 3, harassment: 1 })
})

test('banWhy: scam first, then by count; the admin box or reports alone', () => {
  assert.equal(
    banWhy({ adminMarkedScam: true, reports: { harassment: 1, scam: 2, fake_profile: 3 } }),
    'Banned for a scam or fraud · scam reports: 2 · fake profile reports: 3 · harassment reports: 1',
  )
  assert.equal(banWhy({ adminMarkedScam: false, reports: { scam: 1 } }), 'Banned (scam reports) · scam reports: 1')
  assert.equal(banWhy({ adminMarkedScam: true, reports: {} }), 'Banned for a scam or fraud')
})

test('matchView: from the stored hold; onRecord and "more"; null without context', () => {
  const reason = {
    blocklist: true,
    distance: 3,
    match: { uid: 'u1', name: 'Sam', bannedAt: 1_760_000_000_000, adminMarkedScam: true, reports: { scam: 2 }, distance: 3 },
    more: 2,
  }
  assert.deepEqual(matchView(reason, (u) => u === 'u1'), {
    uid: 'u1',
    name: 'Sam',
    bannedAt: 1_760_000_000_000,
    why: 'Banned for a scam or fraud · scam reports: 2',
    closeness: 'Very close (edited/re-saved)',
    distance: 3,
    more: 2,
    onRecord: true,
  })
  assert.equal(matchView({ ...reason, more: undefined }, () => false)?.more, 0)
  assert.equal(matchView({ ...reason, more: undefined }, () => false)?.onRecord, false)
  assert.equal(matchView({ blocklist: true, distance: 0 }, () => true), null) // a hold from before: no context
  assert.equal(matchView({ nudity: 0.9 }, () => true), null)
  assert.equal(matchView(null, () => true), null)
})
