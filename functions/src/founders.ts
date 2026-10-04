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
// Austin also keeps config/launch and publicStats/founding up to date: they
// are shared with the mobile founder-code program (redeemFounderCode) and
// the landing page. Filling Austin no longer sets config/launch.botsActive,
// because that hides every bot everywhere (onLaunchConfigUpdated).

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getNearestCity } from './cities'

// Per half (women / men); a city's circle is twice this.
const DEFAULT_FOUNDER_TARGET = 50
// Everyone else counts toward the other half.
const MEN_IDENTITIES = new Set(['man', 'trans_man'])
const BOT_PREFIX = 'zbot-'

type Ineligible = 'outside_coverage' | 'already_assigned' | 'cohort_full' | 'no_profile'
type FounderResult =
  | { eligible: true; cohortNumber: number; cityId: string; cityName: string }
  | { eligible: false; reason: Ineligible }

function parseCoords(data: unknown): { lat: number; lng: number } {
  const d = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  const lat = d.locationLat
  const lng = d.locationLng
  if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new HttpsError('invalid-argument', 'locationLat and locationLng required')
  }
  return { lat, lng }
}

// Spark profiles store a string, Play an array; the first entry decides.
function bucketFor(genderIdentity: unknown): 'women' | 'men' {
  const g = Array.isArray(genderIdentity) ? genderIdentity[0] : genderIdentity
  return typeof g === 'string' && MEN_IDENTITIES.has(g) ? 'men' : 'women'
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)

// Location is self-reported (browser geolocation, snapped to ~3 miles), so
// this is a launch-period gate, not proof of residence.
export const assignFounderBadge = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<FounderResult> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const { lat, lng } = parseCoords(request.data)
    const city = getNearestCity(lat, lng)
    if (!city) return { eligible: false, reason: 'outside_coverage' }

    const db = getFirestore()
    const cityRef = db.doc(`config/city_${city.id}`)
    const statsRef = db.doc(`publicStats/city_${city.id}`)
    const launchRef = db.doc('config/launch')
    const userRef = db.doc(`users/${uid}`)
    const isAustin = city.id === 'austin'

    const result = await db.runTransaction(async (tx): Promise<FounderResult> => {
      const [citySnap, userSnap, launchSnap] = await Promise.all([
        tx.get(cityRef),
        tx.get(userRef),
        isAustin ? tx.get(launchRef) : Promise.resolve(null),
      ])
      const user = userSnap.data()
      if (!user || user.onboardingComplete !== true) return { eligible: false, reason: 'no_profile' }
      if (user.isFounder === true) return { eligible: false, reason: 'already_assigned' }

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
      const cohortNumber = Math.max(nextWomen + nextMen, isAustin ? num(launch.founderCount, 0) + 1 : 0)
      const capacity = target * 2

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
          // Both halves full: this city is live, its bots go.
          ...(nextWomen >= target && nextMen >= target && { botsActive: false }),
        },
        { merge: true },
      )
      tx.set(
        statsRef,
        { members: cohortNumber, capacity, cityName: city.name, state: city.state, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      )
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
      })

      // Austin's legacy counters (founder codes count here too).
      if (isAustin) {
        const founderCount = cohortNumber
        tx.set(
          launchRef,
          {
            founderCount,
            [`${bucket}Count`]: bucket === 'women' ? nextWomen : nextMen,
            [bucket === 'women' ? 'austinWomenCount' : 'austinMenCount']:
              num(launch[bucket === 'women' ? 'austinWomenCount' : 'austinMenCount'], 0) + 1,
          },
          { merge: true },
        )
        tx.set(
          db.doc('publicStats/founding'),
          { members: founderCount, capacity: num(launch.founderTarget, capacity), updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        )
      }
      return { eligible: true, cohortNumber, cityId: city.id, cityName: city.name }
    })

    logger.info('assignFounderBadge', {
      city: city.id,
      result: result.eligible ? `founder #${result.cohortNumber}` : result.reason,
    })
    return result
  },
)

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
