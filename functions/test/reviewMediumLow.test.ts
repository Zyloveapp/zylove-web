// Fresh-eyes review, Medium and Low fixes (F-112 – F-125): the pure parts.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Timestamp } from 'firebase-admin/firestore'
import { distanceAllowed, matchIsLive } from '../src/distanceCore'
import { FOUNDER_MIN_AGE_MS, founderGate, founderPhoneHash, revokedPlan } from '../src/founderGate'
import { signupDecision } from '../src/signupGuard'
import { isUsNumber } from '../src/phoneRegion'
import { ipBucket, ipRateKey } from '../src/clientIp'
import { maskProfileText, maskedFields, needsMask } from '../src/profileText'
import { calculateSparkScore, sparkPairFields, sparkScoreFor, sparkViews } from '../src/legacy/scoring'
import { DEALBREAKER_CAP } from '../src/legacy/tier1/scorePair'
import { PAST_DUE_GRACE_MS, computeEntitlement } from '../src/entitlements'
import type { UserDoc } from '../src/legacy/types'

// ─── M6 / M7 (F-117, F-118): distances ───────────────────────────────────────

test('distance: deck, live match, paid likers; never a hidden profile except to a live match', () => {
  const none = { inDeck: false, liveMatch: false, liker: false }
  assert.equal(distanceAllowed(none, { callerPaid: true, targetHidden: false }), false, 'once swiped is not enough any more')
  assert.equal(distanceAllowed({ ...none, inDeck: true }, { callerPaid: false, targetHidden: false }), true)
  assert.equal(distanceAllowed({ ...none, inDeck: true }, { callerPaid: false, targetHidden: true }), false, 'hidden/paused')
  assert.equal(distanceAllowed({ ...none, liveMatch: true }, { callerPaid: false, targetHidden: true }), true, 'a live match still sees it')
  assert.equal(distanceAllowed({ ...none, liker: true }, { callerPaid: false, targetHidden: false }), false, 'free: a liker stays anonymous')
  assert.equal(distanceAllowed({ ...none, liker: true }, { callerPaid: true, targetHidden: false }), true, 'paid plans see their likers')
})

test('distance: an ended match is not live', () => {
  assert.equal(matchIsLive({}), true)
  assert.equal(matchIsLive({ isBlocked: true }), false)
  assert.equal(matchIsLive({ unmatchedAt: 123 }), false)
  assert.equal(matchIsLive({ preservedFor: ['a'] }), false)
})

// ─── M3 / M4 / M5 (F-114 – F-116): founder claims ────────────────────────────

const now = Date.UTC(2026, 9, 9, 12)
const old = now - 3 * FOUNDER_MIN_AGE_MS
const gate = (o: Partial<Parameters<typeof founderGate>[0]>) =>
  founderGate({ accountCreatedAt: old, lineType: 'mobile', recordStatus: undefined, history: undefined, uid: 'u1', now, ...o })

test('founder gate: a day-old account on a mobile line with no spot before', () => {
  assert.equal(gate({}), null)
  assert.equal(gate({ lineType: null }), null, 'unknown line type lets it through')
})

test('founder gate: too new, VoIP, or a spot this number already had', () => {
  assert.equal(gate({ accountCreatedAt: now - 60_000 }), 'too_new')
  assert.equal(gate({ accountCreatedAt: undefined }), 'too_new', 'no recorded age is new')
  assert.equal(gate({ lineType: 'nonFixedVoip' }), 'not_mobile')
  assert.equal(gate({ lineType: 'landline' }), 'not_mobile')
  assert.equal(gate({ recordStatus: 'revoked' }), 'not_available', 'revoked: not again (same account)')
  assert.equal(gate({ history: { status: 'revoked', uid: 'old-uid' } }), 'not_available', 'revoked: not on a new account with the number')
  assert.equal(gate({ history: { status: 'active', uid: 'other' } }), 'not_available', 'the number holds a spot on another account')
  assert.equal(gate({ history: { status: 'active', uid: 'u1' } }), null)
})

test('founder phone hash matches trialHistory/bannedPhones (sha256 of the trimmed number)', () => {
  assert.equal(founderPhoneHash(' +15125550123 '), founderPhoneHash('+15125550123'))
  assert.match(founderPhoneHash('+15125550123'), /^[a-f0-9]{64}$/)
})

test('revoked founder: keeps a trial they had, honours the number history, a new trial only once', () => {
  const t = (d: number) => Timestamp.fromMillis(now + d)
  assert.deepEqual(revokedPlan({ internal: { trialStartedAt: t(-1) }, prior: null, cityOpen: true }), { kind: 'keep' })
  assert.deepEqual(revokedPlan({ internal: { hadPaidPlan: true }, prior: null, cityOpen: true }), { kind: 'paid' })
  assert.deepEqual(revokedPlan({ internal: {}, prior: { hadPaidPlan: true }, cityOpen: true }), { kind: 'paid' })
  const prior = revokedPlan({ internal: {}, prior: { trialStartedAt: t(-40e8), trialEndsAt: t(-10e8) }, cityOpen: true })
  assert.equal(prior.kind, 'prior')
  assert.deepEqual(revokedPlan({ internal: {}, prior: null, cityOpen: true }), { kind: 'new' })
  assert.deepEqual(revokedPlan({ internal: {}, prior: null, cityOpen: false }), { kind: 'prelaunch' })
})

// ─── M11 (F-122): sign-up and texts ──────────────────────────────────────────

test('US numbers only: Canada and the Caribbean share +1 but are refused', () => {
  assert.equal(isUsNumber('+15125551234', { emulator: false }), true)
  assert.equal(isUsNumber('+14165551234', { emulator: false }), false, 'Toronto')
  assert.equal(isUsNumber('+18765551234', { emulator: false }), false, 'Jamaica (premium-rate target)')
  assert.equal(isUsNumber('+447700900123', { emulator: false }), false)
  assert.equal(isUsNumber('+15550101234', { emulator: false }), false, 'fictional 555')
  assert.equal(isUsNumber('+15550101234', { emulator: true }), true, 'emulator test numbers')
})

test('sign-up: a US mobile number; no phone, foreign or VoIP refused', () => {
  const e = { emulator: false }
  assert.deepEqual(signupDecision('+15125551234', 'mobile', e), { ok: true })
  assert.deepEqual(signupDecision('+15125551234', null, e), { ok: true }, 'Lookup unavailable lets it through')
  assert.deepEqual(signupDecision(null, null, e), { ok: false, reason: 'no_phone' })
  assert.deepEqual(signupDecision('+447700900123', null, e), { ok: false, reason: 'not_us' })
  assert.deepEqual(signupDecision('+15125551234', 'nonFixedVoip', e), { ok: false, reason: 'line_type' })
})

// ─── M10 (F-121): addresses ──────────────────────────────────────────────────

test('IPv6 addresses count by their /64; IPv4 as is', () => {
  assert.equal(ipBucket('203.0.113.7'), '203.0.113.7')
  assert.equal(ipBucket('::ffff:203.0.113.7'), '203.0.113.7')
  assert.equal(ipBucket('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64')
  assert.equal(ipBucket('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64')
  assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64')
  assert.equal(ipRateKey('2001:db8:1:2::1'), ipRateKey('2001:db8:1:2:dead:beef:0:1'), 'one /64, one limit')
  assert.notEqual(ipRateKey('2001:db8:1:2::1'), ipRateKey('2001:db8:1:3::1'))
})

// ─── M1 (F-112): profile text ────────────────────────────────────────────────

test('profile text: links, domains, handles, emails and phone numbers are masked; plain text is not', () => {
  for (const bad of [
    'add me on telegram @scamhandle',
    'text me 512 555 0123',
    'me@example.com',
    'see www.example.com',
    'my site is example.com',
    'call (512) 555-0123 ok',
  ]) {
    assert.ok(needsMask(bad), bad)
    assert.ok(maskProfileText(bad).includes('•••'), bad)
  }
  for (const ok of ['I love hiking and Node.js', 'Coffee at 7, dinner at 8', 'Born in 1990', 'The 49ers are my team']) {
    assert.equal(needsMask(ok), false, ok)
  }
  const once = maskProfileText('ig @x_handle and 5125550123')
  assert.equal(maskProfileText(once), once, 'idempotent')
})

test('profile text: only the fields that need it are rewritten', () => {
  assert.equal(maskedFields({ bio: 'hello' }, ['bio'], ['promptAnswers'], []), null)
  const out = maskedFields(
    { bio: 'dm @me', promptAnswers: [{ promptId: 'p1', answer: 'fine' }, { promptId: 'p2', answer: 'call 5125550123' }], playPromptAnswers: { a: 'x.com' } },
    ['bio'], ['promptAnswers'], ['playPromptAnswers'],
  )
  assert.ok(out)
  assert.equal(out!.bio, 'dm •••')
  assert.equal(out!.promptAnswers[0].answer, 'fine')
  assert.ok(out!.promptAnswers[1].answer.includes('•••'))
  assert.equal(out!.playPromptAnswers.a, '•••')
})

// ─── M8 (F-119): each person's own view ──────────────────────────────────────

const man = (o: Record<string, unknown> = {}) =>
  ({ genderIdentity: 'man', attractedTo: ['women'], age: 33, ageMin: 26, ageMax: 40, intent: 'spark', ...o }) as unknown as UserDoc
const woman = (o: Record<string, unknown> = {}) =>
  ({ genderIdentity: 'woman', attractedTo: ['men'], age: 31, ageMin: 28, ageMax: 40, intent: 'spark', ...o }) as unknown as UserDoc
const FULL = {
  personalityTraits: ['grounded', 'caring', 'intellectual'],
  relationshipValues: ['stability', 'loyalty', 'communication'],
  lifestyleTags: ['homebody', 'wellness_focused', 'foodie'],
  weekendVibes: ['slow_mornings', 'cook_something_good', 'recharge_solo'],
  habitTags: ['reader', 'early_riser', 'cigarette_smoker', 'meditates'],
  loveLangGive: ['quality_time', 'acts_of_service'],
  loveLangReceive: ['quality_time', 'acts_of_service'],
}

test("per viewer: someone else's dealbreaker no longer shows in your score or breakdown", () => {
  const he = man(FULL) // smokes
  const she = woman({ ...FULL, dealbreakers: ['cigarette_smoker'] })
  const both = calculateSparkScore(he, she)
  assert.ok(both.score <= DEALBREAKER_CAP, 'the shared score keeps both (match doc)')
  const views = sparkViews(he, she, 'he', 'she')
  // He didn't rule anything out: his view ignores her private dealbreaker.
  assert.equal(views.he.dealbreakers, 100)
  assert.ok(views.he.score > DEALBREAKER_CAP, `his score ${views.he.score}`)
  // Hers fired: she sees it (it's her own preference).
  assert.equal(views.she.dealbreakers, 0)
  assert.ok(views.she.score <= DEALBREAKER_CAP)
  // Toggling his own habits can't reveal hers any more: without the habit his view is unchanged in shape.
  const clean = sparkViews(man({ ...FULL, habitTags: ['reader'] }), she, 'he', 'she')
  assert.equal(clean.he.dealbreakers, views.he.dealbreakers)
})

test('per viewer: stored per person, older docs fall back to the shared score', () => {
  const he = man(FULL)
  const she = woman({ ...FULL, dealbreakers: ['cigarette_smoker'] })
  const views = sparkViews(he, she, 'he', 'she')
  const fields = sparkPairFields(calculateSparkScore(he, she), views)
  assert.equal(fields.sparkScoreFor!.he, views.he.score)
  assert.equal(sparkScoreFor(fields, 'he'), views.he.score)
  assert.equal(sparkScoreFor({ sparkScore: 42 }, 'he'), 42)
  assert.equal(sparkScoreFor(undefined, 'he'), null)
})

// ─── Low: past due ───────────────────────────────────────────────────────────

test('past due: paid access lasts PAST_DUE_GRACE_MS from the first failed payment', () => {
  const root = { identityLockedAt: null }
  const since = Timestamp.fromMillis(now - 2 * 24 * 3600 * 1000)
  const e = computeEntitlement({ root, plan: { subscriptionTier: 'elite', subscriptionStatus: 'past_due', pastDueSince: since } }, now)
  assert.equal(e.tier, 'elite')
  assert.equal(e.until?.toMillis(), since.toMillis() + PAST_DUE_GRACE_MS)
  const late = computeEntitlement({ root, plan: { subscriptionTier: 'elite', subscriptionStatus: 'past_due', pastDueSince: Timestamp.fromMillis(now - PAST_DUE_GRACE_MS - 1) } }, now)
  assert.notEqual(late.source, 'paid')
  const active = computeEntitlement({ root, plan: { subscriptionTier: 'spark_plus', subscriptionStatus: 'active' } }, now)
  assert.equal(active.tier, 'spark_plus')
  assert.equal(active.until, null)
})
