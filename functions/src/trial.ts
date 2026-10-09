import { onSchedule } from 'firebase-functions/v2/scheduler'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { ZYLOVE_CITIES, getNearestCity, type ZyloveCity } from './cities'
import { eliteByMatching } from './identity'

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
// trialStartedAt / trialEndsAt / trialExpired live in userInternal/{uid}
// (server-only) as Timestamps, mirrored read-only to private/account.

export const TRIAL_MS = 30 * 24 * 60 * 60 * 1000

// Stage C (decision 2): by how they're matched (women / nonbinary people),
// not the identity they describe. `user` should carry matchableAs (from
// private/matching) for identities that don't map to a category. H2: the
// gender is read by identity.ts (gender.ts), as Explore reads it.
export function hasEliteIdentity(user: DocumentData): boolean {
  return eliteByMatching(user.genderIdentity, user.matchableAs)
}

export function hasPaidSubscription(user: DocumentData | undefined): boolean {
  return user?.subscriptionStatus === 'active' || user?.subscriptionStatus === 'past_due'
}

// Never on a trial clock: founders, always-Elite identities, paying members.
// `user` is the root doc merged with userInternal (planView), since the plan
// fields live in userInternal.
export function trialExempt(user: DocumentData): boolean {
  return user.isFounder === true || hasEliteIdentity(user) || hasPaidSubscription(user)
}

// Root doc (identity, founder) with the plan from userInternal on top.
export function planView(root: DocumentData | undefined, internal: DocumentData | undefined): DocumentData {
  return { ...(root ?? {}), ...(internal ?? {}) }
}

// The user's launch market: userLocations/{uid}.marketCityId, locked the first
// time they save a location (setLocation), so moving their location later
// can't take them off a market's trial clock. Older records without it fall
// back to the nearest city.
export function marketFor(loc: { lat: number; lng: number; marketCityId: string | null } | null): ZyloveCity | null {
  if (!loc) return null
  if (loc.marketCityId) return ZYLOVE_CITIES.find((c) => c.id === loc.marketCityId) ?? null
  return getNearestCity(loc.lat, loc.lng)
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
// pre-launch line reads it), and start the trial for every non-exempt user
// in that market who doesn't have one (H1: with the phone's trial history,
// as initUserDefaults does).
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

    // Everyone whose locked market is this city — and (Stage C) everyone
    // linked to it from outside every launch radius (single-field queries).
    const [inMarket, linked] = await Promise.all([
      db.collection('userLocations').where('marketCityId', '==', city.id).select().get(),
      db.collection('userLocations').where('linkedCityId', '==', city.id).select().get(),
    ])
    const everyone = [...new Set([...inMarket.docs, ...linked.docs].map((d) => d.id))].filter((id) => !isBotUid(id))
    // H1: each trial as initUserDefaults starts it (accountDefaults.ts): the
    // phone's trial history first — a number that had one, or paid, doesn't
    // get a fresh one — and none for the exempt or suspended.
    const { ensureAccountDefaults } = await import('./accountDefaults')
    let started = 0
    for (const id of everyone) {
      const r = await ensureAccountDefaults(id).catch(() => null)
      if (r?.trial === 'new') started++
    }
    // Everyone's entitlement follows the city (pre-launch → trial).
    const { refreshPlayAccess } = await import('./playAccess')
    for (const id of everyone) await refreshPlayAccess(id).catch(() => {})
    logger.info('onMarketOpened', { city: city.id, trialsStarted: started, refreshed: everyone.length })
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
    const ended = await db.collection('userInternal').where('trialEndsAt', '<', Timestamp.now()).get()
    const expiring = []
    for (const d of ended.docs) {
      // How they're matched decides an exempt identity (§4.A2: gender and
      // matchableAs live in private/matching).
      const [root, matching] = await Promise.all([db.doc(`users/${d.id}`).get(), db.doc(`users/${d.id}/private/matching`).get()])
      const u: DocumentData = { ...planView(root.data(), d.data()), genderIdentity: matching.get('genderIdentity') ?? root.get('genderIdentity'), matchableAs: matching.get('matchableAs') }
      const paidTier = u.subscriptionTier === 'spark_plus' || u.subscriptionTier === 'elite'
      if (u.trialStartedAt != null && u.trialExpired !== true && !trialExempt(u) && !paidTier) expiring.push(d)
    }
    for (let i = 0; i < expiring.length; i += 450) {
      const batch = db.batch()
      for (const d of expiring.slice(i, i + 450)) batch.update(d.ref, { trialExpired: true })
      await batch.commit()
    }
    logger.info('checkTrialStatus', { trialsEnded: ended.size, markedExpired: expiring.length })
  },
)

// ─── Trial history (Stage C) ─────────────────────────────────────────────────
// trialHistory/{phoneHash} (server-only): the trial — and whether they ever
// paid — kept by phone number, so deleting the account and signing up again
// doesn't bring a fresh trial (or pre-launch) back.

export async function priorTrial(phone: string | null | undefined): Promise<DocumentData | null> {
  if (!phone) return null
  const { phoneHash } = await import('./trust')
  return (await getFirestore().doc(`trialHistory/${phoneHash(phone)}`).get()).data() ?? null
}

export async function noteTrialHistory(phone: string | null | undefined, fields: DocumentData): Promise<void> {
  if (!phone) return
  const { phoneHash } = await import('./trust')
  await getFirestore().doc(`trialHistory/${phoneHash(phone)}`).set({ ...fields, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
}
