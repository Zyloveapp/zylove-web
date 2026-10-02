// Austin Founding Circle: the first 50 + 50 members within 40 miles of
// downtown Austin get a permanent founder badge, assigned automatically at
// the end of onboarding. When both halves fill, bots are switched off.
//
// config/launch (server-only) holds the counters; publicStats/founding is the
// public copy the landing page reads (members / capacity, nothing else).

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore'

const AUSTIN = { lat: 30.2672, lng: -97.7431 }
const AUSTIN_RADIUS_MILES = 40
const DEFAULT_THRESHOLD = 50
// Everyone else counts toward the other half.
const MEN_IDENTITIES = new Set(['man', 'trans_man'])
const BOT_PREFIX = 'zbot-'

type Ineligible = 'outside_austin' | 'already_assigned' | 'cohort_full' | 'no_profile'
type FounderResult = { eligible: true; cohortNumber: number } | { eligible: false; reason: Ineligible }

function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

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

// Location is self-reported (browser geolocation, snapped to ~3 miles), so
// this is a launch-period gate, not proof of residence.
export const assignFounderBadge = onCall(
  { timeoutSeconds: 30, memory: '128MiB', invoker: 'public' },
  async (request): Promise<FounderResult> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const { lat, lng } = parseCoords(request.data)
    if (distanceMiles(lat, lng, AUSTIN.lat, AUSTIN.lng) > AUSTIN_RADIUS_MILES) {
      return { eligible: false, reason: 'outside_austin' }
    }

    const db = getFirestore()
    const configRef = db.doc('config/launch')
    const userRef = db.doc(`users/${uid}`)

    const result = await db.runTransaction(async (tx): Promise<FounderResult> => {
      const [configSnap, userSnap] = await Promise.all([tx.get(configRef), tx.get(userRef)])
      const user = userSnap.data()
      if (!user || user.onboardingComplete !== true) return { eligible: false, reason: 'no_profile' }
      if (user.isFounder === true) return { eligible: false, reason: 'already_assigned' }

      // First assignment ever creates config/launch with the launch defaults
      // (same as scripts/init-launch-config.mjs), so nothing depends on the script.
      const config = configSnap.data() ?? { launchThreshold: DEFAULT_THRESHOLD, botsActive: true }
      const threshold = typeof config.launchThreshold === 'number' ? config.launchThreshold : DEFAULT_THRESHOLD
      const women = typeof config.austinWomenCount === 'number' ? config.austinWomenCount : 0
      const men = typeof config.austinMenCount === 'number' ? config.austinMenCount : 0
      const total = typeof config.totalActiveUsers === 'number' ? config.totalActiveUsers : 0

      const bucket = bucketFor(user.genderIdentity)
      if ((bucket === 'women' ? women : men) >= threshold) return { eligible: false, reason: 'cohort_full' }

      const nextWomen = bucket === 'women' ? women + 1 : women
      const nextMen = bucket === 'men' ? men + 1 : men
      const cohortNumber = total + 1

      tx.set(configRef, {
        ...(!configSnap.exists && { launchThreshold: threshold, botsActive: true, createdAt: FieldValue.serverTimestamp() }),
        austinWomenCount: nextWomen,
        austinMenCount: nextMen,
        totalActiveUsers: cohortNumber,
        // Both halves full: launch is real, bots go (see onLaunchConfigUpdated).
        ...(nextWomen >= threshold && nextMen >= threshold && { botsActive: false }),
      }, { merge: true })
      tx.update(userRef, {
        isFounder: true,
        founderCohort: 'Austin',
        founderNumber: cohortNumber,
        founderBadgeAssignedAt: FieldValue.serverTimestamp(),
      })
      tx.set(
        db.doc('publicStats/founding'),
        { members: cohortNumber, capacity: threshold * 2, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      )
      return { eligible: true, cohortNumber }
    })

    logger.info('assignFounderBadge', { result: result.eligible ? `founder #${result.cohortNumber}` : result.reason })
    return result
  },
)

// botsActive true → false: hide every bot (zbot-* uid) in both modes.
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
