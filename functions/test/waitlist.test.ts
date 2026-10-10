// Austin-only launch with city lock/unlock and a waitlist: the pure parts.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Timestamp } from 'firebase-admin/firestore'
import {
  admitsSignups,
  admittingCityAt,
  availableCities,
  cityStatus,
  foundingPeriod,
  nearestLaunchCity,
  servesMembers,
  servingCityAt,
  type CityConfigs,
} from '../src/cityStatus'
import { computeEntitlement } from '../src/entitlements'
import { hasTextConsent } from '../src/waitlist'
import { SMS_CONSENT_SOURCES, SMS_CONSENT_TEXTS, WAITLIST_ACTIVATED_TEXT, waitlistTextConfig } from '../src/sms'

const AUSTIN = { lat: 30.2672, lng: -97.7431 }
const DALLAS = { lat: 32.7767, lng: -96.797 }
const BOISE = { lat: 43.615, lng: -116.2023 } // outside every launch city
const configs = (entries: Record<string, Record<string, unknown>> = {}): CityConfigs => new Map(Object.entries(entries))

test('status: Austin founding and the rest locked by default; the old open flags read as live; a stored status wins', () => {
  assert.equal(cityStatus('austin', undefined), 'founding')
  assert.equal(cityStatus('dallas', undefined), 'locked')
  assert.equal(cityStatus('dallas', { botsActive: true }), 'locked', 'a city doc with bots on is still locked until unlocked')
  assert.equal(cityStatus('dallas', { botsActive: false }), 'live')
  assert.equal(cityStatus('austin', { discoveryOpenedAt: Timestamp.now() }), 'live')
  assert.equal(cityStatus('dallas', { status: 'founding' }), 'founding')
  assert.equal(cityStatus('austin', { status: 'locked', botsActive: false }), 'locked', 'locking a live city')
  assert.equal(cityStatus('dallas', { status: 'bogus' }), 'locked')
  assert.equal(admitsSignups('locked'), false)
  assert.equal(admitsSignups('founding'), true)
  assert.equal(admitsSignups('live'), true)
})

test('lock never removes members: a locked-again city still serves the people there; founding perks only while founding', () => {
  assert.equal(servesMembers('dallas', undefined), false, 'never unlocked')
  assert.equal(servesMembers('dallas', { status: 'locked', unlockedAt: Timestamp.now() }), true, 'locked after an unlock')
  assert.equal(servesMembers('austin', { status: 'locked' }), true, 'Austin was founding from the start')
  assert.equal(foundingPeriod('austin', undefined), true)
  assert.equal(foundingPeriod('dallas', undefined), false, 'locked: no pre-launch Elite, no AI profiles, no founder claims')
  assert.equal(foundingPeriod('dallas', { status: 'founding', unlockedAt: Timestamp.now() }), true)
  assert.equal(foundingPeriod('austin', { status: 'live', botsActive: false }), false)
  assert.equal(foundingPeriod('austin', { status: 'locked' }), true, 'locked Austin: existing members keep the founding period')
})

test('admission: inside a Founding/Live city → that city; outside → waitlisted for the nearest launch city at any distance', () => {
  assert.equal(admittingCityAt(AUSTIN.lat, AUSTIN.lng, configs())?.id, 'austin')
  assert.equal(admittingCityAt(DALLAS.lat, DALLAS.lng, configs()), null, 'Dallas is locked')
  assert.equal(admittingCityAt(DALLAS.lat, DALLAS.lng, configs({ dallas: { status: 'founding' } }))?.id, 'dallas', 'unlocked')
  assert.equal(admittingCityAt(AUSTIN.lat, AUSTIN.lng, configs({ austin: { status: 'locked' } })), null, 'locked: new sign-ups waitlisted')
  assert.equal(admittingCityAt(BOISE.lat, BOISE.lng, configs()), null)
  assert.equal(nearestLaunchCity(DALLAS.lat, DALLAS.lng).id, 'dallas')
  assert.ok(nearestLaunchCity(BOISE.lat, BOISE.lng).id, 'always some city')
  assert.deepEqual(availableCities(configs()).map((c) => c.id), ['austin'])
  assert.deepEqual(availableCities(configs({ dallas: { status: 'live', botsActive: false } })).map((c) => c.id), ['austin', 'dallas'])
  // Members: Austin locked again still serves them.
  assert.equal(servingCityAt(AUSTIN.lat, AUSTIN.lng, configs({ austin: { status: 'locked' } }))?.id, 'austin')
  assert.equal(servingCityAt(BOISE.lat, BOISE.lng, configs()), null, 'a traveller outside: "Zylove isn\'t live here yet"')
})

test('entitlement: pre-launch Elite only in a Founding city; keepAccess keeps it; founders and identity anywhere', () => {
  const root = { onboardingComplete: true }
  const inDallas = { marketCityId: 'dallas' }
  assert.equal(computeEntitlement({ root, loc: { marketCityId: 'austin' }, marketFounding: true }).source, 'prelaunch')
  assert.deepEqual(
    [computeEntitlement({ root, loc: inDallas, marketFounding: false }).tier, computeEntitlement({ root, loc: inDallas, marketFounding: false }).source],
    ['free', 'waiting'],
    'nobody outside an open city gets free Elite',
  )
  assert.equal(computeEntitlement({ root, plan: { keepAccess: true }, loc: inDallas, marketFounding: false }).source, 'prelaunch', 'kept on approval')
  assert.equal(computeEntitlement({ root, loc: inDallas, marketOpen: true, marketFounding: false }).source, 'waiting', 'live city: trial clock')
  assert.equal(computeEntitlement({ root, loc: { marketCityId: 'austin' } }).source, 'prelaunch', 'omitted counts as founding (older callers)')
  assert.equal(computeEntitlement({ root: { ...root, isFounder: true }, loc: inDallas, marketFounding: false }).source, 'founder')
  assert.equal(computeEntitlement({ root, loc: { linkedCityId: 'boise' } }).source, 'waiting')
})

test('waitlist consent: its own versioned wording and source; consent only counts on the same number, not opted out', () => {
  assert.ok(SMS_CONSENT_SOURCES.includes('waitlist'))
  assert.equal(
    SMS_CONSENT_TEXTS['waitlist-2026-10-09'],
    'Text me account notifications from Zylove, including when my account is activated. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.',
  )
  assert.equal(hasTextConsent(undefined, null), false)
  assert.equal(hasTextConsent({ smsConsent: { phone: '+15550100001' } }, '+15550100001'), true)
  assert.equal(hasTextConsent({ smsConsent: { phone: '+15550100001' } }, '+15550100002'), false, 'number changed')
  assert.equal(hasTextConsent({ smsConsent: { phone: '+15550100001' }, smsOptOut: { at: 1 } }, null), false, 'STOP')
})

test('the activation text is a plain account notice; texting is on by default, batched, with a daily cap', () => {
  assert.equal(WAITLIST_ACTIVATED_TEXT, 'Zylove: Your account is now active. Sign in at zylove.app to finish your profile. Reply STOP to opt out.')
  assert.doesNotMatch(WAITLIST_ACTIVATED_TEXT, /!|live|launch/i, 'no hype, no city launch')
  assert.deepEqual(waitlistTextConfig(undefined), { enabled: true, batchSize: 200, dailyCap: 2000 })
  assert.deepEqual(waitlistTextConfig({ enabled: false, batchSize: 50, dailyCap: 500 }), { enabled: false, batchSize: 50, dailyCap: 500 })
  assert.deepEqual(waitlistTextConfig({ batchSize: -1, dailyCap: 'x' }), { enabled: true, batchSize: 200, dailyCap: 2000 })
})
