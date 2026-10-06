// Admin dashboards: the account-deletion queue and per-city founder stats.
// Both read collections clients can't (deletedAccounts, deletionRequests are
// rules-denied; city stats scan every user), so they're callables that check
// the admin auth claim.
//
// Deletion lifecycle (mobile codebase: trustSafety.ts, accountLifecycle.ts,
// onNightlyPurge.ts):
//   grace     requestAccountDeletion → deletionRequests/{uid} (status
//             'pending', scheduledFor ms) + user suspended; cancellable
//   deleted   deleteAccount / processGraceExpiredDeletions → recovery doc
//             deletedAccounts/{E.164 phone} + user doc anonymized
//             (isDeleted, deletedAt); restorable for 90 days
//   purged    onNightlyPurge, 12 months after deletedAt: subcollections,
//             pairs, matches, swipes, user doc, Storage, Auth
//   record    the recovery doc itself is swept 18 months after deletedAt
//             (never if banned: it blocks re-signup)

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { getStorage } from 'firebase-admin/storage'
import { isAdminAuth } from './userData'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { ZYLOVE_CITIES, getNearestCity } from './cities'
import { revokeFounderStatus } from './founderActivity'

const DAY_MS = 24 * 60 * 60 * 1000
const PURGE_AFTER_MS = 365 * DAY_MS // onNightlyPurge's TWELVE_MONTHS_MS
const RECORD_KEPT_MS = 18 * 30 * DAY_MS // its 18-month recovery-doc sweep
const BOT_PREFIX = 'zbot-'

function requireAdmin(auth: { uid: string; token?: Record<string, unknown> } | undefined): string {
  if (!auth) throw new HttpsError('unauthenticated', 'Login required')
  if (!isAdminAuth(auth)) throw new HttpsError('permission-denied', 'Admins only.')
  return auth.uid
}

function ms(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis()
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}

// ─── Deletion queue ──────────────────────────────────────────────────────────

export type DeletionStage = 'grace' | 'deleted' | 'record'

export interface PendingDeletion {
  uid: string
  stage: DeletionStage
  // From the recovery doc; anonymized user docs say '[deleted]'.
  displayName: string | null
  phoneLast4: string | null
  banned: boolean
  // When they asked (grace) or were soft-deleted (deleted, record).
  deletedAt: number | null
  // When the next automatic step removes their data for good: the user
  // purge (grace: from the scheduled soft delete), or the record sweep.
  permanentAt: number | null
}

export const adminListDeletions = onCall(
  { timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ deletions: PendingDeletion[] }> => {
    requireAdmin(request.auth)
    const db = getFirestore()
    const [records, deletedUsers, requests] = await Promise.all([
      db.collection('deletedAccounts').get(),
      db.collection('users').where('isDeleted', '==', true).get(),
      db.collection('deletionRequests').where('status', '==', 'pending').get(),
    ])

    const recordByUid = new Map<string, DocumentData & { id: string }>()
    for (const r of records.docs) {
      const uid: unknown = r.data().previousUid
      if (typeof uid === 'string') recordByUid.set(uid, { ...r.data(), id: r.id })
    }
    const fromRecord = (uid: string) => {
      const r = recordByUid.get(uid)
      const name: unknown = r?.displayName
      return {
        displayName: typeof name === 'string' && name.trim() ? name.trim() : null,
        phoneLast4: r ? r.id.slice(-4) : null,
        banned: r?.banned === true,
      }
    }

    const out = new Map<string, PendingDeletion>()
    // Grace period: no recovery doc yet; the user doc and Auth are still live.
    const graceUsers = requests.empty ? [] : await db.getAll(...requests.docs.map((r) => db.doc(`users/${r.id}`)))
    for (const [i, req] of requests.docs.entries()) {
      const d = req.data()
      const scheduled = ms(d.scheduledFor)
      const name: unknown = graceUsers[i]?.data()?.displayName
      const phone = await getAuth()
        .getUser(req.id)
        .then((u) => u.phoneNumber ?? null)
        .catch(() => null)
      out.set(req.id, {
        uid: req.id,
        stage: 'grace',
        displayName: typeof name === 'string' && name.trim() ? name.trim() : null,
        phoneLast4: phone ? phone.slice(-4) : null,
        banned: false,
        deletedAt: ms(d.requestedAt),
        permanentAt: scheduled === null ? null : scheduled + PURGE_AFTER_MS,
      })
    }
    for (const u of deletedUsers.docs) {
      const deletedAt = ms(u.data().deletedAt)
      out.set(u.id, {
        uid: u.id,
        stage: 'deleted',
        ...fromRecord(u.id),
        deletedAt,
        permanentAt: deletedAt === null ? null : deletedAt + PURGE_AFTER_MS,
      })
    }
    // Recovery docs whose user data is already purged.
    for (const [uid, r] of recordByUid) {
      if (out.has(uid)) continue
      const deletedAt = ms(r.deletedAt)
      out.set(uid, {
        uid,
        stage: 'record',
        ...fromRecord(uid),
        deletedAt,
        permanentAt: r.banned === true || deletedAt === null ? null : deletedAt + RECORD_KEPT_MS,
      })
    }

    const deletions = [...out.values()].sort((a, b) => (a.permanentAt ?? Infinity) - (b.permanentAt ?? Infinity))
    return { deletions }
  },
)

// Removes everything onNightlyPurge would, now, plus what it misses (nested
// subcollections, founder records and threads, review PDFs). A founder spot
// they still hold is released first. Banned recovery docs are kept — they're
// what stops the number signing up again. Only for accounts already in the
// queue, so a live account can't be purged by uid.
export const adminPurgeAccount = onCall(
  { timeoutSeconds: 300, memory: '512MiB', invoker: 'public' },
  async (request): Promise<{ purged: true; keptBannedRecord: boolean }> => {
    const adminUid = requireAdmin(request.auth)
    const uid: unknown = request.data?.uid
    if (typeof uid !== 'string' || !uid || uid.includes('/')) throw new HttpsError('invalid-argument', 'uid required')
    if (uid === adminUid) throw new HttpsError('failed-precondition', "You can't purge your own account.")

    const db = getFirestore()
    const userRef = db.doc(`users/${uid}`)
    const [user, deletionRequest, records] = await Promise.all([
      userRef.get(),
      db.doc(`deletionRequests/${uid}`).get(),
      db.collection('deletedAccounts').where('previousUid', '==', uid).get(),
    ])
    const queued = user.data()?.isDeleted === true || deletionRequest.data()?.status === 'pending' || !records.empty
    if (!queued) throw new HttpsError('failed-precondition', 'This account is not pending deletion.')

    // Release a founder spot before the user doc goes.
    await revokeFounderStatus(uid).catch((err) =>
      logger.warn('adminPurgeAccount: founder release failed', { message: err instanceof Error ? err.message : String(err) }),
    )

    const deleteAll = async (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => {
      for (const d of docs) await d.ref.delete()
    }
    const [pairsA, pairsB, matches, swiper, swiped] = await Promise.all([
      db.collection('pairs').where('userA', '==', uid).get(),
      db.collection('pairs').where('userB', '==', uid).get(),
      db.collection('matches').where('users', 'array-contains', uid).get(),
      db.collection('swipes').where('swiperId', '==', uid).get(),
      db.collection('swipes').where('swipedId', '==', uid).get(),
    ])
    await deleteAll([...pairsA.docs, ...pairsB.docs, ...swiper.docs, ...swiped.docs])
    // With their messages (onNightlyPurge leaves those behind).
    for (const m of matches.docs) await db.recursiveDelete(m.ref)
    for (const path of [`popupTriggers/${uid}`, `deletionRequests/${uid}`, `founderRecords/${uid}`, `keyBackups/${uid}`, `userInternal/${uid}`, `userLocations/${uid}`]) {
      await db.doc(path).delete().catch(() => {})
    }
    await db.recursiveDelete(db.doc(`founderMessages/${uid}`))
    // The user doc and every subcollection under it, however deep.
    await db.recursiveDelete(userRef)

    const bucket = getStorage().bucket()
    for (const prefix of [`photos/${uid}/`, `users/${uid}/`, `reviews/${uid}/`]) {
      await bucket.deleteFiles({ prefix }).catch(() => {})
    }
    await getAuth()
      .deleteUser(uid)
      .catch((err: { code?: string }) => {
        if (err.code !== 'auth/user-not-found') throw err
      })

    let keptBannedRecord = false
    for (const r of records.docs) {
      if (r.data().banned === true) keptBannedRecord = true
      else await r.ref.delete()
    }

    await db.collection('purgeLog').add({
      uid,
      purgedAt: FieldValue.serverTimestamp(),
      reason: 'admin_manual',
      adminUid,
      keptBannedRecord,
    })
    logger.info('adminPurgeAccount', { keptBannedRecord })
    return { purged: true, keptBannedRecord }
  },
)

// ─── City dashboard ──────────────────────────────────────────────────────────

export interface CityRow {
  id: string
  name: string
  state: string
  live: boolean // config/city_{id}.botsActive === false
  women: number
  men: number
  target: number // per half
  sparkPlus: number
  elite: number
  newSignups7d: number
  lastFounderAt: number | null
}

export interface CityStats {
  totals: { founders: number; capacity: number; subscribers: number; paying: number; activeUsers: number; outsideCities: number }
  cities: CityRow[]
  generatedAt: number
}

// Founder counts come from the city docs; everything else from one pass over
// real (non-bot, not deleted, onboarded) users, placed in a city by their
// saved coordinates. Elite includes the complimentary kind (identity,
// founders); paying is Stripe-billed only.
export const adminCityStats = onCall(
  { timeoutSeconds: 120, memory: '512MiB', invoker: 'public' },
  async (request): Promise<CityStats> => {
    requireAdmin(request.auth)
    const db = getFirestore()
    const now = Date.now()
    const [configs, users, internals, locations] = await Promise.all([
      db.getAll(...ZYLOVE_CITIES.map((c) => db.doc(`config/city_${c.id}`))),
      db
        .collection('users')
        .select(
          'locationLat', 'locationLng', 'subscriptionTier', 'subscriptionStatus', 'createdAt', 'isDeleted',
          'onboardingComplete', 'isFounder', 'founderCityId', 'founderBadgeAssignedAt',
        )
        .get(),
      db.collection('userInternal').select('subscriptionTier', 'subscriptionStatus').get(),
      db.collection('userLocations').select('lat', 'lng').get(),
    ])
    // Plan from userInternal, coordinates from userLocations (root copies
    // still count for accounts not yet migrated).
    const internalOf = new Map(internals.docs.map((d) => [d.id, d.data()]))
    const locationOf = new Map(locations.docs.map((d) => [d.id, d.data()]))
    const view = (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
      const loc = locationOf.get(doc.id)
      return {
        ...doc.data(),
        ...internalOf.get(doc.id),
        ...(typeof loc?.lat === 'number' && { locationLat: loc.lat, locationLng: loc.lng }),
      } as FirebaseFirestore.DocumentData
    }

    const rows = new Map<string, CityRow>()
    ZYLOVE_CITIES.forEach((c, i) => {
      const d = configs[i].data() ?? {}
      rows.set(c.id, {
        id: c.id,
        name: c.name,
        state: c.state,
        live: d.botsActive === false,
        women: typeof d.womenCount === 'number' ? d.womenCount : 0,
        men: typeof d.menCount === 'number' ? d.menCount : 0,
        target: typeof d.founderTarget === 'number' ? d.founderTarget : 50,
        sparkPlus: 0,
        elite: 0,
        newSignups7d: 0,
        lastFounderAt: null,
      })
    })

    let activeUsers = 0
    let subscribers = 0
    let paying = 0
    let outsideCities = 0
    for (const doc of users.docs) {
      if (doc.id.startsWith(BOT_PREFIX)) continue
      const u = view(doc)
      if (u.isDeleted === true || u.onboardingComplete !== true) continue
      activeUsers++
      const tier = u.subscriptionTier
      if (tier === 'spark_plus' || tier === 'elite') subscribers++
      if (u.subscriptionStatus === 'active' || u.subscriptionStatus === 'past_due') paying++

      const city =
        typeof u.locationLat === 'number' && typeof u.locationLng === 'number' ? getNearestCity(u.locationLat, u.locationLng) : null
      const row = city ? rows.get(city.id) : undefined
      if (!row) {
        outsideCities++
        continue
      }
      if (tier === 'spark_plus') row.sparkPlus++
      if (tier === 'elite') row.elite++
      const created = ms(u.createdAt)
      if (created !== null && now - created <= 7 * DAY_MS) row.newSignups7d++
    }
    // Last founder by founderCityId, wherever they are now.
    for (const doc of users.docs) {
      const u = doc.data()
      const row = typeof u.founderCityId === 'string' ? rows.get(u.founderCityId) : undefined
      const at = ms(u.founderBadgeAssignedAt)
      if (row && u.isFounder === true && at !== null && (row.lastFounderAt === null || at > row.lastFounderAt)) row.lastFounderAt = at
    }

    const cities = [...rows.values()].sort((a, b) => b.women + b.men - (a.women + a.men) || a.name.localeCompare(b.name))
    return {
      totals: {
        founders: cities.reduce((s, c) => s + c.women + c.men, 0),
        capacity: cities.reduce((s, c) => s + c.target * 2, 0),
        subscribers,
        paying,
        activeUsers,
        outsideCities,
      },
      cities,
      generatedAt: now,
    }
  },
)
