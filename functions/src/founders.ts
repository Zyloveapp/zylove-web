// Austin Founding Circle: members within 40 miles of downtown Austin get a
// permanent founder badge (and Elite, as with a founder code), assigned
// automatically at the end of onboarding, until each half is full. When both
// halves fill, bots are switched off.
//
// config/launch (server-only) holds the counters, shared with the mobile
// founder-code program (redeemFounderCode): founderCount, womenCount,
// menCount against founderTarget, womenTarget, menTarget. publicStats/founding
// is the public copy the landing page reads (members / capacity only).

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore'

const AUSTIN = { lat: 30.2672, lng: -97.7431 }
const AUSTIN_RADIUS_MILES = 40
// Used only if config/launch is missing a target.
const DEFAULTS = { founderTarget: 100, womenTarget: 50, menTarget: 50 }
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
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
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

      // A missing config/launch is created with the default targets.
      const config = configSnap.data() ?? { ...DEFAULTS, botsActive: true }
      const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)
      const founderTarget = num(config.founderTarget, DEFAULTS.founderTarget)
      const womenTarget = num(config.womenTarget, DEFAULTS.womenTarget)
      const menTarget = num(config.menTarget, DEFAULTS.menTarget)
      const founders = num(config.founderCount, 0)
      const women = num(config.womenCount, 0)
      const men = num(config.menCount, 0)

      const bucket = bucketFor(user.genderIdentity)
      if (bucket === 'women' ? women >= womenTarget : men >= menTarget) return { eligible: false, reason: 'cohort_full' }

      const nextWomen = bucket === 'women' ? women + 1 : women
      const nextMen = bucket === 'men' ? men + 1 : men
      const cohortNumber = founders + 1

      tx.set(
        configRef,
        {
          ...(!configSnap.exists && { ...DEFAULTS, botsActive: true, createdAt: FieldValue.serverTimestamp() }),
          founderCount: cohortNumber,
          womenCount: nextWomen,
          menCount: nextMen,
          // Both halves full: launch is real, bots go (see onLaunchConfigUpdated).
          ...(nextWomen >= womenTarget && nextMen >= menTarget && { botsActive: false }),
        },
        { merge: true },
      )
      tx.update(userRef, {
        isFounder: true,
        founderCohort: 'Austin',
        founderNumber: cohortNumber,
        founderBadgeAssignedAt: FieldValue.serverTimestamp(),
        // Same perk as a founder code (redeemFounderCode).
        subscriptionTier: 'elite',
      })
      tx.set(
        db.doc('publicStats/founding'),
        { members: cohortNumber, capacity: founderTarget, updatedAt: FieldValue.serverTimestamp() },
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
