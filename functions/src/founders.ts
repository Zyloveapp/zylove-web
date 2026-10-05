// City founding circles: members within 50 miles of a launch city
// (cities.ts) get a permanent "<City> Founder" badge and Elite, assigned
// automatically at the end of onboarding, until that city's half (women or
// men) is full. When both halves fill, the city's bots go off for viewers in
// that city (discover.ts reads config/city_{id}.botsActive).
//
// config/city_{id} (server-only) holds each city's counters: womenCount,
// menCount against founderTarget (per half). publicStats/city_{id} is the
// public copy (members / capacity). Flat ids: config and publicStats are
// one-level collections in the rules.
//
// Founders must stay active during launch (founderActivity.ts). The
// lifecycle lives in founderRecords/{uid}, which only Cloud Functions can
// read or write (rules default-deny); the users/{uid} copies (founderStatus,
// founderLastActiveAt, …) are display mirrors, since clients can edit
// those fields on their own doc.
//
// Austin also keeps config/launch and publicStats/founding up to date: they
// are shared with the mobile founder-code program (redeemFounderCode) and
// the landing page. Filling Austin no longer sets config/launch.botsActive,
// because that hides every bot everywhere (onLaunchConfigUpdated).

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore'
import { ZYLOVE_CITIES, getNearestCity } from './cities'
import { SMS_SECRETS, sendSMS, smsTarget } from './sms'

// Per half (women / men); a city's circle is twice this.
export const DEFAULT_FOUNDER_TARGET = 50
// Everyone else counts toward the other half.
const MEN_IDENTITIES = new Set(['man', 'trans_man'])
const BOT_PREFIX = 'zbot-'

type Ineligible = 'outside_coverage' | 'already_assigned' | 'cohort_full' | 'no_profile'
export type FounderResult =
  | { eligible: true; cohortNumber: number; cityId: string; cityName: string }
  | { eligible: false; reason: Ineligible }
// The transaction also says whether this claim was the one that filled the city.
type Claim = FounderResult & { closedCity?: boolean }

function parseCoords(data: unknown): { lat: number; lng: number } {
  const d = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  const lat = d.locationLat
  const lng = d.locationLng
  if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new HttpsError('invalid-argument', 'locationLat and locationLng required')
  }
  return { lat, lng }
}

export type Bucket = 'women' | 'men'

// Lifecycle (founderRecords/{uid}.status). Spot holders count toward the
// city's womenCount/menCount; only active and permanent founders count as
// members on the public counter.
export type FounderStatus = 'active' | 'pending_revocation' | 'permanent' | 'revoked' | 'converted'
const MEMBER_STATUSES = new Set(['active', 'permanent'])

// Spark profiles store a string, Play an array; the first entry decides.
export function bucketFor(genderIdentity: unknown): Bucket {
  const g = Array.isArray(genderIdentity) ? genderIdentity[0] : genderIdentity
  return typeof g === 'string' && MEN_IDENTITIES.has(g) ? 'men' : 'women'
}

export const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)

// Account-level founder texts: either mode's SMS switch will do (smsTarget
// also checks quiet hours and that there's a number).
export async function textFounder(uid: string, body: string): Promise<boolean> {
  const target = (await smsTarget(uid, 'founder', 'spark')) ?? (await smsTarget(uid, 'founder', 'play'))
  return target ? sendSMS(target.phone, body) : false
}

// The city's founders, current and older (founderCohort only), deduped.
async function cityFounders(cityId: string, cityName: string) {
  const users = getFirestore().collection('users')
  const [byId, byName] = await Promise.all([
    users.where('founderCityId', '==', cityId).select('isFounder', 'founderStatus').get(),
    users.where('founderCohort', '==', cityName).select('isFounder', 'founderStatus').get(),
  ])
  const seen = new Map<string, FirebaseFirestore.DocumentData>()
  for (const d of [...byId.docs, ...byName.docs]) if (!seen.has(d.id)) seen.set(d.id, d.data())
  return seen
}

// Both halves just filled: the city is live (bots off, distance filtering
// on — discover.ts reads botsActive). Tell its founders.
async function announceCityLive(cityId: string, cityName: string): Promise<void> {
  try {
    const founders = await cityFounders(cityId, cityName)
    const body = `✦ ${cityName} is live. Your founding circle is complete — real connections, real people, just in your area. Distance filtering is now active. zylove.app`
    let sent = 0
    for (const [uid, u] of founders) {
      if (u.isFounder !== true) continue
      if (await textFounder(uid, body)) sent++
    }
    logger.info('announceCityLive', { cityId, founders: founders.size, sent })
  } catch (err) {
    logger.error('announceCityLive failed', { cityId, message: err instanceof Error ? err.message : String(err) })
  }
}

// Location is self-reported (browser geolocation, snapped to ~3 miles), so
// this is a launch-period gate, not proof of residence.
export const assignFounderBadge = onCall(
  { timeoutSeconds: 60, memory: '256MiB', invoker: 'public', secrets: SMS_SECRETS },
  async (request): Promise<FounderResult> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const { lat, lng } = parseCoords(request.data)
    return claimFounderSpot(request.auth.uid, lat, lng, 'assignFounderBadge')
  },
)

// The founder claim itself: the city at (lat, lng), its half's counter, the
// user's founder fields and lifecycle record. Shared by the user's own
// claim and the admin dashboard's "Make founder" (which passes the user's
// saved location). The caller must provide SMS_SECRETS (city-live texts).
export async function claimFounderSpot(uid: string, lat: number, lng: number, source: string): Promise<FounderResult> {
  const city = getNearestCity(lat, lng)
  if (!city) return { eligible: false, reason: 'outside_coverage' }

  const db = getFirestore()
  const cityRef = db.doc(`config/city_${city.id}`)
  const statsRef = db.doc(`publicStats/city_${city.id}`)
  const launchRef = db.doc('config/launch')
  const userRef = db.doc(`users/${uid}`)
  const recordRef = db.doc(`founderRecords/${uid}`)
  const isAustin = city.id === 'austin'

  const claim = await db.runTransaction(async (tx): Promise<Claim> => {
    const [citySnap, userSnap, launchSnap, recordSnap] = await Promise.all([
      tx.get(cityRef),
      tx.get(userRef),
      isAustin ? tx.get(launchRef) : Promise.resolve(null),
      tx.get(recordRef),
    ])
    const user = userSnap.data()
    if (!user || user.onboardingComplete !== true) return { eligible: false, reason: 'no_profile' }
    if (user.isFounder === true) return { eligible: false, reason: 'already_assigned' }
    // Revoked founders may claim again; converted ones (Spark+ for good)
    // already had their turn.
    if (recordSnap.data()?.status === 'converted') return { eligible: false, reason: 'already_assigned' }

    // A missing city doc is created with the defaults (init-cities.mjs
    // normally makes them first).
    const config = citySnap.data() ?? {}
    const target = num(config.founderTarget, DEFAULT_FOUNDER_TARGET)
    // Austin founder codes (mobile) only count in config/launch, so Austin
    // goes by whichever count is higher; the city doc catches up on write.
    const launch = launchSnap?.data() ?? {}
    const women = Math.max(num(config.womenCount, 0), isAustin ? num(launch.womenCount, 0) : 0)
    const men = Math.max(num(config.menCount, 0), isAustin ? num(launch.menCount, 0) : 0)

    const bucket = bucketFor(user.genderIdentity)
    if ((bucket === 'women' ? women : men) >= target) return { eligible: false, reason: 'cohort_full' }

    const nextWomen = bucket === 'women' ? women + 1 : women
    const nextMen = bucket === 'men' ? men + 1 : men
    // Member numbers never repeat, even after revocations free spots.
    const cohortNumber = Math.max(num(config.founderSeq, women + men), isAustin ? num(launch.founderCount, 0) : 0) + 1
    const capacity = target * 2
    const fills = nextWomen >= target && nextMen >= target

    tx.set(
      cityRef,
      {
        ...(!citySnap.exists && {
          id: city.id,
          name: city.name,
          state: city.state,
          lat: city.lat,
          lng: city.lng,
          radiusMiles: city.radiusMiles,
          founderTarget: target,
          botsActive: true,
          createdAt: FieldValue.serverTimestamp(),
        }),
        womenCount: nextWomen,
        menCount: nextMen,
        founderSeq: cohortNumber,
        // Both halves full: this city is live, its bots go, and its trials
        // start (trial.ts onMarketOpened).
        ...(fills && { botsActive: false, discoveryOpenedAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    )
    // members is recounted after the transaction (refreshCityMembers).
    tx.set(statsRef, { capacity, cityName: city.name, state: city.state }, { merge: true })
    tx.set(recordRef, {
      uid,
      cityId: city.id,
      cityName: city.name,
      bucket,
      status: 'active' satisfies FounderStatus,
      acceptedAt: FieldValue.serverTimestamp(),
      lastActiveAt: FieldValue.serverTimestamp(),
      warningSentAt: null,
      pendingAt: null,
    })
    tx.update(userRef, {
      isFounder: true,
      // Display name, as the mobile app shows it ("Founding Member — Austin").
      founderCohort: city.name,
      founderCity: city.name,
      founderCityId: city.id,
      founderBadge: `${city.badgeName ?? city.name} Founder`,
      founderNumber: cohortNumber,
      founderBadgeAssignedAt: FieldValue.serverTimestamp(),
      // Same perk as a founder code (redeemFounderCode).
      subscriptionTier: 'elite',
      founderStatus: 'active',
      founderStatusAcceptedAt: FieldValue.serverTimestamp(),
      founderLastActiveAt: FieldValue.serverTimestamp(),
    })

    // Austin's legacy counters (founder codes count here too).
    if (isAustin) {
      tx.set(
        launchRef,
        {
          founderCount: num(launch.founderCount, 0) + 1,
          [`${bucket}Count`]: bucket === 'women' ? nextWomen : nextMen,
          [bucket === 'women' ? 'austinWomenCount' : 'austinMenCount']:
            num(launch[bucket === 'women' ? 'austinWomenCount' : 'austinMenCount'], 0) + 1,
        },
        { merge: true },
      )
    }
    return { eligible: true, cohortNumber, cityId: city.id, cityName: city.name, closedCity: fills && config.botsActive !== false }
  })
  const { closedCity, ...result } = claim
  if (result.eligible) await refreshCityMembers(city.id)
  if (closedCity) await announceCityLive(city.id, city.name)

  logger.info(source, {
    city: city.id,
    result: result.eligible ? `founder #${result.cohortNumber}` : result.reason,
  })
  return result
}

// Recounts publicStats/city_{id}.members from the founders themselves:
// active and permanent only. Founders from before the lifecycle (no status,
// e.g. founder codes) count as active. Austin's count also goes to
// publicStats/founding, which the landing page reads. Never throws.
export async function refreshCityMembers(cityId: string): Promise<void> {
  const city = ZYLOVE_CITIES.find((c) => c.id === cityId)
  if (!city) return
  try {
    const db = getFirestore()
    const users = db.collection('users')
    // Older founders have only founderCohort (the city name).
    const [byId, byName] = await Promise.all([
      users.where('founderCityId', '==', city.id).select('isFounder', 'founderStatus').get(),
      users.where('founderCohort', '==', city.name).select('isFounder', 'founderStatus').get(),
    ])
    const seen = new Set<string>()
    let members = 0
    for (const d of [...byId.docs, ...byName.docs]) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      const u = d.data()
      const status: unknown = u.founderStatus
      if (u.isFounder === true && (status === undefined || (typeof status === 'string' && MEMBER_STATUSES.has(status)))) members++
    }
    const stamp = { members, updatedAt: FieldValue.serverTimestamp() }
    await db.doc(`publicStats/city_${city.id}`).set(stamp, { merge: true })
    if (city.id === 'austin') await db.doc('publicStats/founding').set(stamp, { merge: true })
  } catch (err) {
    logger.error('refreshCityMembers failed', { cityId, message: err instanceof Error ? err.message : String(err) })
  }
}

// config/launch.botsActive true → false (a manual kill switch now): hide
// every bot (zbot-* uid) in both modes, everywhere.
export const onLaunchConfigUpdated = onDocumentUpdated(
  { document: 'config/launch', timeoutSeconds: 300 },
  async (event) => {
    const before = event.data?.before.data()
    const after = event.data?.after.data()
    if (before?.botsActive !== true || after?.botsActive !== false) return

    const db = getFirestore()
    // '.' is the character after '-', so this range is exactly the zbot- ids.
    const bots = await db
      .collection('users')
      .where(FieldPath.documentId(), '>=', BOT_PREFIX)
      .where(FieldPath.documentId(), '<', 'zbot.')
      .get()

    for (let i = 0; i < bots.docs.length; i += 400) {
      const batch = db.batch()
      for (const doc of bots.docs.slice(i, i + 400)) {
        batch.update(doc.ref, { sparkVisibility: 'hidden', playVisibility: 'hidden' })
      }
      await batch.commit()
    }
    logger.info('onLaunchConfigUpdated: bots hidden', { count: bots.size })
  },
)
