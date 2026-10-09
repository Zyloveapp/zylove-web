// H1 (fresh-eyes review): no Elite "pre-launch" once the city is open, the
// trial decided server-side (with the phone's history), probation for an
// account with no recorded age.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Timestamp } from 'firebase-admin/firestore'
import { computeEntitlement } from '../src/entitlements'
import { decideTrial, memberSinceOf, needsAccountDefaults } from '../src/accountDefaults'
import { probationFor, PROBATION_DEFAULTS } from '../src/probation'

const DAY = 864e5
const root = { identityLockedAt: Timestamp.now() }
const man = { genderIdentity: 'man', matchableAs: [] }
const austin = { marketCityId: 'austin' }

test('entitlement: market open and no trial is Free (waiting), never pre-launch', () => {
  const e = computeEntitlement({ root, plan: {}, matching: man, loc: austin, marketOpen: true })
  assert.equal(e.tier, 'free')
  assert.equal(e.source, 'waiting')
  assert.equal(e.until, null)
  assert.equal(e.cityId, 'austin')
  // Missing marketOpen counts as not open (founding): pre-launch, as before.
  assert.equal(computeEntitlement({ root, plan: {}, matching: man, loc: austin }).source, 'prelaunch')
  assert.equal(computeEntitlement({ root, plan: {}, matching: man, loc: austin, marketOpen: false }).tier, 'elite')
})

test('entitlement: a linked launch city that opened is Free until the trial starts', () => {
  const loc = { linkedCityId: 'austin' }
  for (const linkedCityOpen of [true, false]) {
    const e = computeEntitlement({ root, plan: {}, matching: man, loc, linkedCityOpen })
    assert.equal(e.tier, 'free')
    assert.equal(e.source, 'waiting')
  }
})

test('entitlement: once the trial starts it decides, with its end', () => {
  const now = Date.now()
  const plan = { trialStartedAt: Timestamp.fromMillis(now), trialEndsAt: Timestamp.fromMillis(now + 30 * DAY), trialExpired: false }
  const e = computeEntitlement({ root, plan, matching: man, loc: austin, marketOpen: true }, now)
  assert.equal(e.tier, 'elite')
  assert.equal(e.source, 'trial')
  assert.equal(e.until?.toMillis(), now + 30 * DAY)
  // Identity, founder and paid come first, whatever the city.
  assert.equal(computeEntitlement({ root: { ...root, isFounder: true }, plan: {}, matching: man, loc: austin, marketOpen: true }).source, 'founder')
  assert.equal(computeEntitlement({ root, plan: {}, matching: { genderIdentity: 'woman' }, loc: austin, marketOpen: true }).source, 'identity')
  assert.equal(computeEntitlement({ root, plan: { subscriptionTier: 'elite' }, matching: man, loc: austin, marketOpen: true }).source, 'paid')
})

const ts = (ms: number) => Timestamp.fromMillis(ms)

test('trial decision: new only in an open city; the phone\'s history wins', () => {
  const base = { root: {}, internal: {}, matching: man, prior: null }
  assert.equal(decideTrial({ ...base, cityOpen: true }).kind, 'new')
  assert.equal(decideTrial({ ...base, cityOpen: false }).kind, 'none')
  // The same phone had a trial (a deleted account): that one, never a new one.
  const prior = { trialStartedAt: ts(Date.now() - 40 * DAY), trialEndsAt: ts(Date.now() - 10 * DAY) }
  const d = decideTrial({ ...base, cityOpen: true, prior })
  assert.equal(d.kind, 'prior')
  assert.equal(d.kind === 'prior' && d.trialEndsAt.toMillis(), prior.trialEndsAt.toMillis())
  // …even in a city that hasn't opened (as initUserDefaults did).
  assert.equal(decideTrial({ ...base, cityOpen: false, prior }).kind, 'prior')
  // It paid before: Free, no trial.
  assert.equal(decideTrial({ ...base, cityOpen: true, prior: { hadPaidPlan: true, ...prior } }).kind, 'paid')
})

test('trial decision: nothing for a started trial, a past paid plan, the suspended or the exempt', () => {
  const base = { root: {}, matching: man, prior: null, cityOpen: true }
  assert.equal(decideTrial({ ...base, internal: { trialStartedAt: ts(Date.now()) } }).kind, 'none')
  assert.equal(decideTrial({ ...base, internal: { hadPaidPlan: true } }).kind, 'none')
  assert.equal(decideTrial({ ...base, internal: { isSuspended: true } }).kind, 'none')
  assert.equal(decideTrial({ ...base, root: { isSuspended: true }, internal: {} }).kind, 'none')
  assert.equal(decideTrial({ ...base, root: { isFounder: true }, internal: {} }).kind, 'none')
  assert.equal(decideTrial({ ...base, matching: { genderIdentity: 'woman' }, internal: {} }).kind, 'none')
  assert.equal(decideTrial({ ...base, internal: { subscriptionStatus: 'active' } }).kind, 'none')
})

test('account defaults: what still needs filling in', () => {
  assert.equal(needsAccountDefaults(undefined, {}), false)
  assert.equal(needsAccountDefaults({ isDeleted: true }, {}), false)
  assert.equal(needsAccountDefaults({ memberSince: '2026-10' }, { accountCreatedAt: 1, trialStartedAt: ts(1) }), false)
  assert.equal(needsAccountDefaults({ memberSince: '2026-10' }, { accountCreatedAt: 1, hadPaidPlan: true }), false)
  assert.equal(needsAccountDefaults({ memberSince: '2026-10' }, { trialStartedAt: ts(1) }), true)
  assert.equal(needsAccountDefaults({}, { accountCreatedAt: 1, trialStartedAt: ts(1) }), true)
  assert.equal(needsAccountDefaults({ memberSince: '2026-10' }, { accountCreatedAt: 1 }), true)
  assert.equal(memberSinceOf(Date.UTC(2026, 9, 9, 12)), '2026-10')
})

test('probation: a missing account age counts as new', () => {
  const on = { enabled: true }
  const now = Date.now()
  assert.deepEqual(probationFor(on, undefined, now), { likesPerDay: PROBATION_DEFAULTS.likesPerDay, noChatPhotos: true })
  assert.deepEqual(probationFor(on, null, now), { likesPerDay: PROBATION_DEFAULTS.likesPerDay, noChatPhotos: true })
  assert.deepEqual(probationFor(on, 'yesterday', now), { likesPerDay: PROBATION_DEFAULTS.likesPerDay, noChatPhotos: true })
  assert.notEqual(probationFor(on, now - DAY, now), null)
  assert.equal(probationFor(on, now - 8 * DAY, now), null)
  assert.equal(probationFor({ enabled: true, days: 30, likesPerDay: 2 }, now - 8 * DAY, now)?.likesPerDay, 2)
  // Switch off: nobody.
  assert.equal(probationFor({ enabled: false }, undefined, now), null)
  assert.equal(probationFor(undefined, undefined, now), null)
})
