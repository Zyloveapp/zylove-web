import { onSchedule } from 'firebase-functions/v2/scheduler'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { ZYLOVE_CITIES, getNearestCity, type ZyloveCity } from './cities'

// The 30-day free trial runs only once discovery is open in the user's
// market. Until then everyone is free ("pre-launch": no trialStartedAt).
//
//   market   the launch city whose radius covers the user's saved location
//            (cities.ts, 50 miles). None: pre-launch until a city near
//            them is added and opens.
//   open     config/city_{id}: discoveryOpenedAt set, or botsActive false
//            (founders.ts sets both when the founding circle fills).
//   starts   onMarketOpened, for everyone already in the market when it
//            opens; initUserDefaults, for anyone who signs up (or shows up)
//            in a market that's already open.
//   exempt   founders, the always-Elite identities, paying subscribers:
//            never on a clock, never expire.
//
// trialStartedAt / trialEndsAt / trialExpired are server-only (Firestore
// rules block client writes) and stored as Timestamps.

export const TRIAL_MS = 30 * 24 * 60 * 60 * 1000

// Women and other non-male identities get lifetime Elite on the web
// ('nonbinary' is how it's stored). Mobile still elevates only woman /
// trans_woman.
export const ALWAYS_ELITE_IDENTITIES = ['woman', 'trans_woman', 'nonbinary', 'non_binary', 'genderfluid', 'agender', 'self_describe']

function genderOf(user: DocumentData): string {
  const g: unknown = Array.isArray(user.genderIdentity) ? user.genderIdentity[0] : user.genderIdentity
  return typeof g === 'string' ? g.toLowerCase().trim() : ''
}

export function hasEliteIdentity(user: DocumentData): boolean {
  const g = genderOf(user)
  return ALWAYS_ELITE_IDENTITIES.includes(g) || g === 'cis woman'
}

export function hasPaidSubscription(user: DocumentData | undefined): boolean {
  return user?.subscriptionStatus === 'active' || user?.subscriptionStatus === 'past_due'
}

// Never on a trial clock: founders, always-Elite identities, paying members.
export function trialExempt(user: DocumentData): boolean {
  return user.isFounder === true || hasEliteIdentity(user) || hasPaidSubscription(user)
}

// The user's launch market, from their saved location.
// TODO: locationLat/locationLng are client-written, so a user can move their
// saved location to a pre-launch city and stay off the clock. Future fix:
// lock the market server-side the first time a location is saved (e.g. a
// server-only marketCityId) and use that here instead of live coordinates.
export function marketFor(user: DocumentData): ZyloveCity | null {
  const lat: unknown = user.locationLat
  const lng: unknown = user.locationLng
  if (typeof lat !== 'number' || typeof lng !== 'number') return null
  return getNearestCity(lat, lng)
}

export function cityOpen(config: DocumentData | undefined): boolean {
  return config?.discoveryOpenedAt != null || config?.botsActive === false
}

export async function marketOpen(city: ZyloveCity): Promise<boolean> {
  return cityOpen((await getFirestore().doc(`config/city_${city.id}`).get()).data())
}

// A fresh 30-day trial from now.
export function newTrial(now = Timestamp.now()): { trialStartedAt: Timestamp; trialEndsAt: Timestamp; trialExpired: false } {
  return { trialStartedAt: now, trialEndsAt: Timestamp.fromMillis(now.toMillis() + TRIAL_MS), trialExpired: false }
}

// Back to pre-launch (revoked founders in a market that hasn't opened).
export const CLEAR_TRIAL = {
  trialStartedAt: FieldValue.delete(),
  trialEndsAt: FieldValue.delete(),
  trialExpired: FieldValue.delete(),
}

const isBotUid = (uid: string) => uid.startsWith('zbot-') || uid.startsWith('seed-')

// ─── onMarketOpened ──────────────────────────────────────────────────────────

// A city opening (config/city_{id} goes from not open to open): stamp
// discoveryOpenedAt, publish it to publicStats/city_{id} (the web app's
// pre-launch line reads it), and start the trial for every non-exempt,
// onboarded user in that market who doesn't have one. Users still in
// onboarding get theirs from initUserDefaults when they finish.
export const onMarketOpened = onDocumentWritten(
  { document: 'config/{docId}', timeoutSeconds: 540, memory: '512MiB' },
  async (event) => {
    const { docId } = event.params
    if (!docId.startsWith('city_')) return
    const before = event.data?.before.data()
    const after = event.data?.after.data()
    if (cityOpen(before) || !cityOpen(after)) return
    const city = ZYLOVE_CITIES.find((c) => `city_${c.id}` === docId)
    if (!city) return

    const db = getFirestore()
    const stamped: unknown = after?.discoveryOpenedAt
    const openedAt = stamped instanceof Timestamp ? stamped : Timestamp.now()
    if (!(stamped instanceof Timestamp)) await db.doc(`config/${docId}`).update({ discoveryOpenedAt: openedAt })
    await db.doc(`publicStats/${docId}`).set({ discoveryOpen: true, discoveryOpenedAt: openedAt }, { merge: true })

    // Whole collection, read once: no index answers "near this city".
    // TODO: this scans every user, which won't hold up at scale. Before then,
    // switch to a market-indexed query — e.g. a server-written marketCityId on
    // users/{uid} (the same field the location-spoofing fix above needs) and
    // where('marketCityId', '==', city.id), paged.
    const users = await db
      .collection('users')
      .select('locationLat', 'locationLng', 'genderIdentity', 'isFounder', 'subscriptionStatus', 'trialStartedAt', 'onboardingComplete')
      .get()
    const starting = users.docs.filter((d) => {
      const u = d.data()
      return (
        !isBotUid(d.id) &&
        u.onboardingComplete === true &&
        u.trialStartedAt === undefined &&
        !trialExempt(u) &&
        marketFor(u)?.id === city.id
      )
    })
    const trial = newTrial()
    for (let i = 0; i < starting.length; i += 450) {
      const batch = db.batch()
      for (const d of starting.slice(i, i + 450)) batch.update(d.ref, trial)
      await batch.commit()
    }
    logger.info('onMarketOpened', { city: city.id, trialsStarted: starting.length })
  },
)

// ─── checkTrialStatus ────────────────────────────────────────────────────────

// 3am Central: flags trials that have ended (trialExpired: true). Only a
// started trial has a trialEndsAt, so pre-launch users never match; exempt
// and paying users are skipped. subscriptionTier is left alone — Stripe sets
// it when they pay. Only trialEndsAt is queried (a single-field index).
export const checkTrialStatus = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'America/Chicago', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db = getFirestore()
    const ended = await db.collection('users').where('trialEndsAt', '<', Timestamp.now()).get()
    const expiring = ended.docs.filter((d) => {
      const u = d.data()
      const paidTier = u.subscriptionTier === 'spark_plus' || u.subscriptionTier === 'elite'
      return u.trialStartedAt != null && u.trialExpired !== true && !trialExempt(u) && !paidTier
    })
    for (let i = 0; i < expiring.length; i += 450) {
      const batch = db.batch()
      for (const d of expiring.slice(i, i + 450)) batch.update(d.ref, { trialExpired: true })
      await batch.commit()
    }
    logger.info('checkTrialStatus', { trialsEnded: ended.size, markedExpired: expiring.length })
  },
)
