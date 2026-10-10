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
// Revoking frees the spot (city + Austin legacy counters); the app offers it
// to people in that city and half (onboarding invitation, profile banner).
// Founders get texts about their own spot only, through smsTarget: consent,
// SMS on, not opted out, not in quiet hours.

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { SMS_SECRETS } from './sms'
import { revokedPlan } from './founderGate'
import { bucketFor, num, refreshCityMembers, textFounder, type Bucket, type FounderStatus } from './founders'
import { CLEAR_TRIAL, cityOpen, hasEliteIdentity, hasPaidSubscription, newTrial, planView } from './trial'
import { accountRef, internalRef, loadInternal, matchingRef } from './userData'

const DAY_MS = 24 * 60 * 60 * 1000
const LAUNCH_WINDOW_DAYS = 90
const FOUNDER_WINDOW_DAYS = 180
const RULES = {
  launch: { warn: 7, pending: 10, revoke: 14 },
  later: { warn: 23, pending: 26, revoke: 30 },
}
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
    await accountRef(uid).set({ founderStatus: 'active' }, { merge: true })
    if (reactivated) {
      logger.info('founderHeartbeat: reactivated', { cityId: record.cityId })
      await refreshCityMembers(record.cityId)
    }
    return { status: 'active' }
  },
)

// ─── Revocation ──────────────────────────────────────────────────────────────

// Takes the founder spot back: not a founder, back to the plan anyone else
// in their city gets (trial.ts) — a fresh 30-day trial if the city has
// opened, pre-launch (no clock) if not; neither if Stripe is billing them or
// their identity gets Elite — and the spot freed in the city's counters. Returns the opened spot, or null if
// the record had already moved on.
export async function revokeFounderStatus(uid: string): Promise<{ cityId: string; bucket: Bucket } | null> {
  const db = getFirestore()
  const recordRef = db.doc(`founderRecords/${uid}`)
  const userRef = db.doc(`users/${uid}`)
  const planRef = internalRef(uid)
  const launchRef = db.doc('config/launch')

  // F-116: the number's trial history (by the hash kept on the record).
  const before = (await recordRef.get()).data() as (FounderRecord & { phoneHash?: string }) | undefined
  const prior = before?.phoneHash ? ((await db.doc(`trialHistory/${before.phoneHash}`).get()).data() ?? null) : null
  const started: { trial: ReturnType<typeof newTrial> | null } = { trial: null }
  const opened = await db.runTransaction(async (tx) => {
    const record = (await tx.get(recordRef)).data() as (FounderRecord & { phoneHash?: string }) | undefined
    if (!record || (record.status !== 'active' && record.status !== 'pending_revocation')) return null
    const cityRef = db.doc(`config/city_${record.cityId}`)
    const isAustin = record.cityId === 'austin'
    const [userSnap, planSnap, citySnap, launchSnap, matchingSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(planRef),
      tx.get(cityRef),
      isAustin ? tx.get(launchRef) : Promise.resolve(null),
      tx.get(matchingRef(uid)),
    ])
    // §4.A2: how they're matched (gender, matchableAs) is in private/matching;
    // the public doc's old copies count until migrated.
    const root = userSnap.data()
    const m = matchingSnap.data()
    const user = root ? { ...root, genderIdentity: m?.genderIdentity ?? root.genderIdentity, matchableAs: m?.matchableAs ?? root.matchableAs } : undefined
    const bucket = record.bucket ?? bucketFor(user?.genderIdentity, user?.matchableAs)
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
    // F-116: the number can't claim a spot again.
    if (record.phoneHash) tx.set(db.doc(`founderHistory/${record.phoneHash}`), { status: 'revoked', uid, revokedAt: FieldValue.serverTimestamp() }, { merge: true })
    if (user) {
      // Not paying (checked below), so exempt only by identity: Elite.
      // F-116: otherwise the trial rules (revokedPlan) — it used to be a
      // fresh 30-day trial on every revocation.
      const decision = revokedPlan({ internal: planSnap.data(), prior, cityOpen: cityOpen(citySnap.data()) })
      const trialFields =
        decision.kind === 'keep' ? {}
        : decision.kind === 'paid' ? { hadPaidPlan: true, ...CLEAR_TRIAL }
        : decision.kind === 'prior' ? { trialStartedAt: decision.trialStartedAt, trialEndsAt: decision.trialEndsAt, trialExpired: decision.trialEndsAt.toMillis() <= Date.now() }
        : decision.kind === 'new' ? newTrial()
        : CLEAR_TRIAL
      if (decision.kind === 'new') started.trial = trialFields as ReturnType<typeof newTrial>
      const plan = hasEliteIdentity(user) ? { subscriptionTier: 'elite' } : { subscriptionTier: 'free', ...trialFields }
      tx.update(userRef, { isFounder: false })
      tx.set(accountRef(uid), { founderStatus: 'revoked' }, { merge: true })
      if (!hasPaidSubscription(planView(user, planSnap.data()))) tx.set(planRef, plan, { merge: true })
    }
    return { cityId: record.cityId, bucket }
  })

  if (opened) {
    logger.info('revokeFounderStatus', opened)
    await refreshCityMembers(opened.cityId)
  }
  // F-116: a trial started here is on record for the number, like any other.
  if (started.trial && before?.phoneHash) {
    await db.doc(`trialHistory/${before.phoneHash}`).set({ trialStartedAt: started.trial.trialStartedAt, trialEndsAt: started.trial.trialEndsAt, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  }
  return opened
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
      await accountRef(record.uid).set({ founderStatus: 'permanent' }, { merge: true })
      return 'permanent'
    }
    // The city never filled: thank them with Spark+ for good. Their spot
    // isn't handed back (counters unchanged); they just stop counting as
    // members.
    const plan = await loadInternal(record.uid)
    await recordRef.update({ status: 'converted' satisfies FounderStatus, convertedAt: FieldValue.serverTimestamp() })
    await userRef.update({ isFounder: false })
    await accountRef(record.uid).set({ founderStatus: 'converted' }, { merge: true })
    if (!hasPaidSubscription(plan)) await internalRef(record.uid).set({ subscriptionTier: 'spark_plus' }, { merge: true })
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
    await accountRef(record.uid).set({ founderStatus: 'pending_revocation' }, { merge: true })
    await textFounder(record.uid, `✦ Your Zylove founder spot expires in 4 days. Log in to keep it: ${APP_URL}`)
    return 'pending'
  }

  if (idleDays >= rules.warn) {
    if (record.warningSentAt) return 'ok'
    await recordRef.update({ warningSentAt: FieldValue.serverTimestamp() })
    await textFounder(
      record.uid,
      `✦ Hey — your ${record.cityName} founder spot is at risk. Log in to Zylove to keep it: ${APP_URL}`,
    )
    return 'warned'
  }

  // Active again (the heartbeat normally does this first).
  if (record.status === 'pending_revocation') {
    await recordRef.update({ status: 'active' satisfies FounderStatus, warningSentAt: null, pendingAt: null })
    await accountRef(record.uid).set({ founderStatus: 'active' }, { merge: true })
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
    const touched = new Set<string>()
    for (const doc of records.docs) {
      const record = { ...(doc.data() as FounderRecord), uid: doc.id }
      try {
        const outcome = await checkOne(record, await cityClosed(record.cityId), now)
        counts[outcome] = (counts[outcome] ?? 0) + 1
        if (outcome !== 'ok' && outcome !== 'warned') touched.add(record.cityId)
        if (outcome === 'revoked') {
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
    // Open spots are offered in the app (onboarding invitation, profile
    // banner); no texts (SMS is account and match/message notifications only).
    if (opened.size > 0) logger.info('checkFounderActivity: spots opened', { openings: [...opened.values()] })
    logger.info('checkFounderActivity done', { founders: records.size, ...counts })
  },
)
