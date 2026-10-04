// Founder activity: founders keep their spot by showing up while their city
// launches. founderRecords/{uid} (server-only, written by assignFounderBadge)
// is the source of truth; users/{uid} gets display copies.
//
//   days since accepting   warn   at risk (pending)   revoke
//   0–90 (launch)          7      10                  14     days inactive
//   91–180                 23     26                  30
//   180+                   city closed (botsActive false) → permanent, never checked again
//                          city still open → converted: Spark+ forever, no longer a founder
//
// Revoking frees the spot (city + Austin legacy counters) and texts a few
// people in that city and half who could claim it (/claim-founder).
// Every text goes through smsTarget: SMS on, a number on file, not in quiet
// hours.

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { ZYLOVE_CITIES, distanceMiles } from './cities'
import { SMS_SECRETS, sendSMS, smsTarget } from './sms'
import { bucketFor, num, refreshCityMembers, type Bucket, type FounderStatus } from './founders'

const DAY_MS = 24 * 60 * 60 * 1000
const TRIAL_MS = 30 * DAY_MS
const LAUNCH_WINDOW_DAYS = 90
const FOUNDER_WINDOW_DAYS = 180
const RULES = {
  launch: { warn: 7, pending: 10, revoke: 14 },
  later: { warn: 23, pending: 26, revoke: 30 },
}
// Open-spot texts: 3 per spot, at most 10 per city/half per run, and never
// more than one claim text per person per day.
const TEXTS_PER_SPOT = 3
const MAX_TEXTS_PER_OPENING = 10
const CLAIM_SMS_COOLDOWN_MS = DAY_MS
const BOT_PREFIX = 'zbot-'
const APP_URL = 'zylove.app'

interface FounderRecord {
  uid: string
  cityId: string
  cityName: string
  bucket: Bucket
  status: FounderStatus
  acceptedAt: Timestamp | null
  lastActiveAt: Timestamp | null
  warningSentAt: Timestamp | null
  pendingAt: Timestamp | null
}

function millis(v: unknown): number | null {
  return v instanceof Timestamp ? v.toMillis() : null
}

// Stripe owns the tier while a paid subscription is live.
function hasPaidSubscription(user: DocumentData | undefined): boolean {
  return user?.subscriptionStatus === 'active' || user?.subscriptionStatus === 'past_due'
}

// Account-level texts: either mode's SMS switch will do.
async function textFounder(uid: string, body: string): Promise<boolean> {
  const target = (await smsTarget(uid, 'founder', 'spark')) ?? (await smsTarget(uid, 'founder', 'play'))
  return target ? sendSMS(target.phone, body) : false
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

// Called by the web app on load (throttled to once an hour per browser).
// Records activity for an active or at-risk founder; an at-risk founder who
// comes back is active again straight away.
export const founderHeartbeat = onCall(
  { timeoutSeconds: 20, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ status: FounderStatus | null }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const db = getFirestore()
    const ref = db.doc(`founderRecords/${uid}`)
    const snap = await ref.get()
    const record = snap.data() as FounderRecord | undefined
    if (!record || (record.status !== 'active' && record.status !== 'pending_revocation')) {
      return { status: record?.status ?? null }
    }
    const reactivated = record.status === 'pending_revocation'
    const now = FieldValue.serverTimestamp()
    await ref.update({ lastActiveAt: now, status: 'active', warningSentAt: null, pendingAt: null })
    await db.doc(`users/${uid}`).update({ founderLastActiveAt: now, founderStatus: 'active' })
    if (reactivated) {
      logger.info('founderHeartbeat: reactivated', { cityId: record.cityId })
      await refreshCityMembers(record.cityId)
    }
    return { status: 'active' }
  },
)

// ─── Revocation ──────────────────────────────────────────────────────────────

// Takes the founder spot back: not a founder, a fresh 30-day trial (unless
// Stripe is billing them, or their identity already gets Elite), and the
// spot freed in the city's counters. Returns the opened spot, or null if
// the record had already moved on.
export async function revokeFounderStatus(uid: string): Promise<{ cityId: string; bucket: Bucket } | null> {
  const db = getFirestore()
  const recordRef = db.doc(`founderRecords/${uid}`)
  const userRef = db.doc(`users/${uid}`)
  const launchRef = db.doc('config/launch')

  const opened = await db.runTransaction(async (tx) => {
    const record = (await tx.get(recordRef)).data() as FounderRecord | undefined
    if (!record || (record.status !== 'active' && record.status !== 'pending_revocation')) return null
    const cityRef = db.doc(`config/city_${record.cityId}`)
    const isAustin = record.cityId === 'austin'
    const [userSnap, citySnap, launchSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(cityRef),
      isAustin ? tx.get(launchRef) : Promise.resolve(null),
    ])
    const user = userSnap.data()
    const bucket = record.bucket ?? bucketFor(user?.genderIdentity)
    const countKey = bucket === 'women' ? 'womenCount' : 'menCount'
    const down = (v: unknown) => Math.max(0, num(v, 0) - 1)

    tx.update(recordRef, { status: 'revoked' satisfies FounderStatus, revokedAt: FieldValue.serverTimestamp() })
    tx.set(cityRef, { [countKey]: down(citySnap.data()?.[countKey]) }, { merge: true })
    if (isAustin) {
      const launch = launchSnap?.data() ?? {}
      const austinKey = bucket === 'women' ? 'austinWomenCount' : 'austinMenCount'
      tx.set(
        launchRef,
        { founderCount: down(launch.founderCount), [countKey]: down(launch[countKey]), [austinKey]: down(launch[austinKey]) },
        { merge: true },
      )
    }
    if (user) {
      tx.update(userRef, {
        isFounder: false,
        founderStatus: 'revoked',
        founderRevokedAt: FieldValue.serverTimestamp(),
        ...(!hasPaidSubscription(user) && {
          subscriptionTier: 'trial',
          trialStartedAt: FieldValue.serverTimestamp(),
          trialEndsAt: Timestamp.fromMillis(Date.now() + TRIAL_MS),
          trialExpired: false,
        }),
      })
    }
    return { cityId: record.cityId, bucket }
  })

  if (opened) {
    logger.info('revokeFounderStatus', opened)
    await refreshCityMembers(opened.cityId)
  }
  return opened
}

// ─── Open-spot texts ─────────────────────────────────────────────────────────

// Texts up to min(3 × spots, 10) people within the city's radius, in the
// half that opened, who aren't founders and haven't had a claim text in the
// last day. Bots and the people just revoked are skipped. Reads every
// unsuspended user, which is fine at launch scale.
async function textOpenSpot(cityId: string, bucket: Bucket, spots: number, skip: Set<string>): Promise<number> {
  const city = ZYLOVE_CITIES.find((c) => c.id === cityId)
  if (!city || spots <= 0) return 0
  const db = getFirestore()
  const snap = await db
    .collection('users')
    .where('isSuspended', '==', false)
    .select('locationLat', 'locationLng', 'genderIdentity', 'isFounder', 'smsConsent', 'claimSMSSentAt')
    .get()
  const now = Date.now()
  const candidates = snap.docs.filter((d) => {
    const u = d.data()
    if (d.id.startsWith(BOT_PREFIX) || skip.has(d.id) || u.isFounder === true) return false
    if (typeof u.smsConsent !== 'object' || u.smsConsent === null) return false
    if (typeof u.locationLat !== 'number' || typeof u.locationLng !== 'number') return false
    if (distanceMiles(u.locationLat, u.locationLng, city.lat, city.lng) > city.radiusMiles) return false
    if (bucketFor(u.genderIdentity) !== bucket) return false
    const last = millis(u.claimSMSSentAt)
    return last === null || now - last >= CLAIM_SMS_COOLDOWN_MS
  })
  // Shuffled: nobody is always first in line.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }

  const limit = Math.min(spots * TEXTS_PER_SPOT, MAX_TEXTS_PER_OPENING)
  const body = `✦ A ${city.name} founder spot just opened. You're invited — Elite access forever, free. First to claim it wins: ${APP_URL}/claim-founder?city=${city.id}&gender=${bucket}`
  let sent = 0
  for (const d of candidates) {
    if (sent >= limit) break
    if (!(await textFounder(d.id, body))) continue
    sent++
    await d.ref.update({ claimSMSSentAt: FieldValue.serverTimestamp() })
  }
  logger.info('textOpenSpot', { cityId, bucket, spots, candidates: candidates.length, sent })
  return sent
}

// ─── Daily check ─────────────────────────────────────────────────────────────

type Outcome = 'ok' | 'warned' | 'pending' | 'revoked' | 'permanent' | 'converted' | 'reactivated'

async function checkOne(record: FounderRecord, cityClosed: boolean, now: number): Promise<Outcome> {
  const db = getFirestore()
  const recordRef = db.doc(`founderRecords/${record.uid}`)
  const userRef = db.doc(`users/${record.uid}`)
  const accepted = millis(record.acceptedAt) ?? now
  const lastActive = millis(record.lastActiveAt) ?? accepted
  const ageDays = (now - accepted) / DAY_MS
  const idleDays = (now - lastActive) / DAY_MS

  if (ageDays >= FOUNDER_WINDOW_DAYS) {
    if (cityClosed) {
      await recordRef.update({ status: 'permanent' satisfies FounderStatus, permanentAt: FieldValue.serverTimestamp() })
      await userRef.update({ founderStatus: 'permanent' })
      return 'permanent'
    }
    // The city never filled: thank them with Spark+ for good. Their spot
    // isn't handed back (counters unchanged); they just stop counting as
    // members.
    const user = (await userRef.get()).data()
    await recordRef.update({ status: 'converted' satisfies FounderStatus, convertedAt: FieldValue.serverTimestamp() })
    await userRef.update({
      isFounder: false,
      founderStatus: 'converted',
      founderConvertedAt: FieldValue.serverTimestamp(),
      ...(!hasPaidSubscription(user) && { subscriptionTier: 'spark_plus' }),
    })
    await textFounder(
      record.uid,
      `✦ Zylove is still growing in ${record.cityName}. Thank you for being here from the start — your Spark+ access is yours forever. ${APP_URL}`,
    )
    return 'converted'
  }

  const rules = ageDays <= LAUNCH_WINDOW_DAYS ? RULES.launch : RULES.later
  if (idleDays >= rules.revoke) return (await revokeFounderStatus(record.uid)) ? 'revoked' : 'ok'

  if (idleDays >= rules.pending) {
    if (record.status === 'pending_revocation') return 'ok'
    await recordRef.update({ status: 'pending_revocation' satisfies FounderStatus, pendingAt: FieldValue.serverTimestamp() })
    await userRef.update({ founderStatus: 'pending_revocation' })
    await textFounder(record.uid, `✦ Your Zylove founder spot expires in 4 days. Log in to keep it: ${APP_URL}`)
    return 'pending'
  }

  if (idleDays >= rules.warn) {
    if (record.warningSentAt) return 'ok'
    await recordRef.update({ warningSentAt: FieldValue.serverTimestamp() })
    await userRef.update({ founderWarningSentAt: FieldValue.serverTimestamp() })
    await textFounder(
      record.uid,
      `✦ Hey — your ${record.cityName} founder spot is at risk. Log in to Zylove to keep it: ${APP_URL}`,
    )
    return 'warned'
  }

  // Active again (the heartbeat normally does this first).
  if (record.status === 'pending_revocation') {
    await recordRef.update({ status: 'active' satisfies FounderStatus, warningSentAt: null, pendingAt: null })
    await userRef.update({ founderStatus: 'active' })
    return 'reactivated'
  }
  return 'ok'
}

export const checkFounderActivity = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB', secrets: SMS_SECRETS },
  async () => {
    const db = getFirestore()
    const now = Date.now()
    const records = await db.collection('founderRecords').where('status', 'in', ['active', 'pending_revocation']).get()

    // City closed = both halves filled (config/city_{id}.botsActive false).
    const closed = new Map<string, boolean>()
    async function cityClosed(cityId: string): Promise<boolean> {
      if (!closed.has(cityId)) {
        const snap = await db.doc(`config/city_${cityId}`).get().catch(() => null)
        closed.set(cityId, snap?.data()?.botsActive === false)
      }
      return closed.get(cityId) ?? false
    }

    const counts: Partial<Record<Outcome, number>> = {}
    const opened = new Map<string, { cityId: string; bucket: Bucket; spots: number }>()
    const revoked = new Set<string>()
    const touched = new Set<string>()
    for (const doc of records.docs) {
      const record = { ...(doc.data() as FounderRecord), uid: doc.id }
      try {
        const outcome = await checkOne(record, await cityClosed(record.cityId), now)
        counts[outcome] = (counts[outcome] ?? 0) + 1
        if (outcome !== 'ok' && outcome !== 'warned') touched.add(record.cityId)
        if (outcome === 'revoked') {
          revoked.add(record.uid)
          const key = `${record.cityId}:${record.bucket}`
          const entry = opened.get(key) ?? { cityId: record.cityId, bucket: record.bucket, spots: 0 }
          entry.spots++
          opened.set(key, entry)
        }
      } catch (err) {
        logger.error('checkFounderActivity: founder failed', {
          cityId: record.cityId,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }

    for (const cityId of touched) await refreshCityMembers(cityId)
    for (const { cityId, bucket, spots } of opened.values()) await textOpenSpot(cityId, bucket, spots, revoked)
    logger.info('checkFounderActivity done', { founders: records.size, ...counts })
  },
)
