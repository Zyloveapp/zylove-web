// Privacy-policy retention: cutoffs, what counts as due, protected reports.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Timestamp } from 'firebase-admin/firestore'
import { RETENTION, cutoffMs, cutoffValue, isDue, reportProtected, type RetentionEntry } from '../src/retention'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 8, 8, 40)
const entry = (c: string) => RETENTION.find((e) => e.collection === c) as RetentionEntry

test('retention: the periods the privacy policy promises', () => {
  for (const c of ['reports', 'reviews', 'unmatchReasons', 'scoreEvents', 'reviewQueue', 'vibeChecks', 'blocks', 'usage', 'notificationCaps', 'purgeLog']) {
    assert.equal(entry(c).maxAgeMs, 730 * DAY, c)
  }
  for (const c of ['contactMessages', 'waitlist', 'foundingApplications']) assert.equal(entry(c).maxAgeMs, 365 * DAY, c)
  assert.equal(new Set(RETENTION.map((e) => e.collection)).size, RETENTION.length)
})

test('retention: cutoff is now minus the period, in the field type', () => {
  assert.equal(cutoffMs(entry('reports'), NOW), NOW - 730 * DAY)
  assert.equal(cutoffMs(entry('waitlist'), NOW), NOW - 365 * DAY)
  const ts = cutoffValue('timestamp', NOW - 365 * DAY)
  assert.ok(ts instanceof Timestamp)
  assert.equal(ts.toMillis(), NOW - 365 * DAY)
  assert.equal(cutoffValue('millis', 123), 123)
})

test('retention: due only past the cutoff, in the right type; undated never due', () => {
  const cut = cutoffMs(entry('reviews'), NOW)
  const reviews = entry('reviews')
  assert.equal(isDue(reviews, { createdAt: Timestamp.fromMillis(cut - 1) }, cut), true)
  assert.equal(isDue(reviews, { createdAt: Timestamp.fromMillis(cut) }, cut), false)
  assert.equal(isDue(reviews, {}, cut), false)
  assert.equal(isDue(reviews, { createdAt: cut - DAY }, cut), false) // a number isn't a Timestamp
  const reports = entry('reports')
  assert.equal(isDue(reports, { reportedAt: cut - 1 }, cut), true)
  assert.equal(isDue(reports, { reportedAt: Timestamp.fromMillis(cut - 1) }, cut), false)
})

test('retention: reviewQueue — either date, and every date it has must be past', () => {
  const q = entry('reviewQueue')
  const cut = cutoffMs(q, NOW)
  const old = Timestamp.fromMillis(cut - DAY)
  const recent = Timestamp.fromMillis(NOW - DAY)
  assert.equal(isDue(q, { createdAt: old }, cut), true)
  assert.equal(isDue(q, { updatedAt: old }, cut), true)
  assert.equal(isDue(q, { createdAt: old, updatedAt: recent }, cut), false)
  assert.equal(isDue(q, { updatedAt: recent }, cut), false)
})

test('retention: a report stays while open, held or in the locker', () => {
  assert.equal(reportProtected({ status: 'pending' }, false), true)
  assert.equal(reportProtected({}, false), true)
  assert.equal(reportProtected({ status: 'reviewing' }, false), true)
  assert.equal(reportProtected({ status: 'actioned', legalHold: { kind: 'legal' } }, false), true)
  assert.equal(reportProtected({ status: 'cleared' }, true), true)
  assert.equal(reportProtected({ status: 'actioned', legalHold: null }, false), false)
  assert.equal(reportProtected({ status: 'cleared' }, false), false)
})
