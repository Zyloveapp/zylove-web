// T&S Phase 1 — risk score rules, group baselines and device helpers.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { FLAG_AT, MIN_COHORT, baselineOf, featuresOf, scoreFeatures, type Features } from '../src/trustScore'
import { hashValue, networkOf, uaFamily } from '../src/devices'

const base = (o: Partial<Features> = {}): Features => ({
  ...featuresOf({ root: { photoURLs: ['a', 'b'] }, internal: { accountCreatedAt: Date.now() - 60 * 864e5 }, signals: {} }),
  ...o,
})

test('an ordinary account scores 0 and is not flagged', () => {
  const r = scoreFeatures(base({ swipes7d: 80, interestedRatio: 0.4, medianSwipeSec: 6, conversationsStarted: 4 }), null)
  assert.equal(r.score, 0)
  assert.deepEqual(r.reasons, [])
})

test('one weak signal never flags on its own', () => {
  for (const f of [base({ sharedIpAccounts: 3 }), base({ capHitDays30: 12 }), base({ bannedIpMatch: true }), base({ blocksReceived: 3 })]) {
    const r = scoreFeatures(f, null)
    assert.ok(r.score < FLAG_AT, `${JSON.stringify(r.reasons)}`)
  }
})

test('strong signals flag, with a plain reason for each point', () => {
  const banned = scoreFeatures(base({ bannedDeviceMatch: true }), null)
  assert.ok(banned.score >= FLAG_AT)
  assert.equal(banned.reasons[0].key, 'banned_device')
  assert.match(banned.reasons[0].text, /device that a banned account used/)
  const spam = scoreFeatures(base({ duplicateOpenerRecipients: 12 }), null)
  assert.ok(spam.score >= FLAG_AT)
  assert.match(spam.reasons[0].text, /same first message to 12 people/)
  const reported = scoreFeatures(base({ reporters90d: 2, urgentReports90d: 1 }), null)
  assert.ok(reported.score >= FLAG_AT, String(reported.score))
})

test('shared device: more accounts, more points (capped)', () => {
  const one = scoreFeatures(base({ sharedDeviceAccounts: 1 }), null).score
  const three = scoreFeatures(base({ sharedDeviceAccounts: 3 }), null).score
  const nine = scoreFeatures(base({ sharedDeviceAccounts: 9 }), null).score
  assert.ok(one < three && three <= nine && nine <= 45)
})

test('group comparison: only far outliers count, only in groups big enough', () => {
  const rows = Array.from({ length: MIN_COHORT + 10 }, (_, i) => base({ swipesPerDay: 40 + (i % 10), interestedRatio: 0.3 + (i % 5) / 100 }))
  const b = baselineOf(rows)
  assert.ok(b.stats.swipesPerDay, 'baseline for swipesPerDay')
  const typical = scoreFeatures(base({ swipesPerDay: 45 }), b)
  assert.equal(typical.reasons.filter((r) => r.key.startsWith('cohort_')).length, 0)
  const outlier = scoreFeatures(base({ swipesPerDay: 400 }), b)
  const r = outlier.reasons.find((x) => x.key === 'cohort_swipesPerDay')
  assert.ok(r, 'outlier reason')
  assert.match(r!.text, /far from their group's typical/)
  // A small group: no comparison at all.
  const small = baselineOf(rows.slice(0, 5))
  assert.equal(scoreFeatures(base({ swipesPerDay: 400 }), small).reasons.length, 0)
})

test('score is capped at 100', () => {
  const r = scoreFeatures(base({ bannedDeviceMatch: true, sharedDeviceAccounts: 5, duplicateOpenerRecipients: 20, reporters90d: 5, urgentReports90d: 3 }), null)
  assert.equal(r.score, 100)
})

test('features: reply rates need enough conversations; stale duplicate openers expire', () => {
  const now = Date.now()
  const f = featuresOf({ signals: { conversationsStarted: 3, repliesReceived: 0, duplicateOpener: { recipients24h: 9, senders24h: 1, at: now - 8 * 864e5 } }, now })
  assert.equal(f.openerReplyRate, null)
  assert.equal(f.duplicateOpenerRecipients, 0)
  const g = featuresOf({ signals: { conversationsStarted: 10, repliesReceived: 1, conversationsReceived: 6, repliesGiven: 3 }, now })
  assert.equal(g.openerReplyRate, 0.1)
  assert.equal(g.replyRate, 0.5)
})

test('devices: networks, user-agent families, keyed hashes', () => {
  assert.equal(networkOf('203.0.113.77'), '203.0.113.0/24')
  assert.equal(networkOf('::ffff:198.51.100.4'), '198.51.100.0/24')
  assert.equal(networkOf('2001:db8:1:2::5'), '2001:db8:1::/48')
  assert.equal(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'iOS Safari')
  assert.equal(uaFamily('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36'), 'Android Chrome')
  const a = hashValue('ip', '203.0.113.77', 'k1')
  assert.equal(a, hashValue('ip', '203.0.113.77', 'k1'))
  assert.notEqual(a, hashValue('ip', '203.0.113.77', 'k2'))
  assert.notEqual(a, hashValue('device', '203.0.113.77', 'k1'))
  assert.match(a, /^[a-f0-9]{64}$/)
})
