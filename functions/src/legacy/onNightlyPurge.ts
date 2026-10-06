// functions/src/onNightlyPurge.ts
//
// Runs nightly at 2am CT.
// Finds accounts deleted more than 12 months ago and hard deletes them:
//   - Firestore user doc + all subcollections
//   - Firebase Storage photos
//   - Firebase Auth account
//
// Export this from functions/src/index.ts:
//   export { onNightlyPurge } from './onNightlyPurge'

import * as admin from 'firebase-admin'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { LEGACY_RUNTIME } from './legacyOptions'
import { ROOT_SCRUB, clearPrivateData } from '../userData'



const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000

export const onNightlyPurge = onSchedule(
  { schedule: '0 2 * * *', timeZone: 'America/Chicago', ...LEGACY_RUNTIME },
  async () => {
    const db = admin.firestore()
const storage = admin.storage()
const auth = admin.auth()
    const cutoff = new Date(Date.now() - TWELVE_MONTHS_MS)
    const cutoffTimestamp = admin.firestore.Timestamp.fromDate(cutoff)

    console.log(`[onNightlyPurge] Running. Purging accounts deleted before ${cutoff.toISOString()}`)

    const snap = await db
      .collection('users')
      .where('isDeleted', '==', true)
      .where('deletedAt', '<=', cutoffTimestamp)
      .get()

    if (snap.empty) {
      console.log('[onNightlyPurge] No accounts to purge.')
      return
    }

    console.log(`[onNightlyPurge] Found ${snap.size} account(s) to purge.`)

    for (const userDoc of snap.docs) {
      const uid = userDoc.id
      console.log(`[onNightlyPurge] Purging uid: ${uid}`)

      try {
        // ── Delete Firestore subcollections ─────────────────────────────
        const subcollections = [
          'sparkProfile',
          'playProfile',
          'settings',
          'seekingPreferences',
          'likeQueue',
          'blockedUsers',
          // Added — these were leaving zombies on every prior account
          // deletion. See docs/memory/account_deletion_cascade_gap.md.
          'legalAcceptance',
          'matchIndex',
          'profileViews',
          'matches',
          'private',
        ]

        for (const sub of subcollections) {
          const subSnap = await db.collection(`users/${uid}/${sub}`).get()
          const batch = db.batch()
          subSnap.docs.forEach(d => batch.delete(d.ref))
          if (!subSnap.empty) await batch.commit()
        }

        // ── Cross-collection cleanup ────────────────────────────────────
        // Top-level docs that reference the uid. Must run BEFORE the user
        // doc delete so any downstream reads that join on user data work.

        // pairs/{pairId} where userA or userB matches the uid
        const [pairsAsA, pairsAsB] = await Promise.all([
          db.collection('pairs').where('userA', '==', uid).get(),
          db.collection('pairs').where('userB', '==', uid).get(),
        ])
        for (const p of [...pairsAsA.docs, ...pairsAsB.docs]) {
          await p.ref.delete()
        }

        // matches/{matchId} where users[] contains the uid
        const matchesSnap = await db
          .collection('matches')
          .where('users', 'array-contains', uid)
          .get()
        for (const m of matchesSnap.docs) {
          await m.ref.delete()
        }

        // swipes/* where the uid is either swiper or swiped side
        const [swipesAsSwiper, swipesAsSwiped] = await Promise.all([
          db.collection('swipes').where('swiperId', '==', uid).get(),
          db.collection('swipes').where('swipedId', '==', uid).get(),
        ])
        for (const s of [...swipesAsSwiper.docs, ...swipesAsSwiped.docs]) {
          await s.ref.delete()
        }

        // popupTriggers/{uid} — single doc keyed by uid
        const popupSnap = await db.collection('popupTriggers').doc(uid).get()
        if (popupSnap.exists) await popupSnap.ref.delete()

        // deletionRequests/{uid} — leftover grace-period doc if any
        const delReqSnap = await db.collection('deletionRequests').doc(uid).get()
        if (delReqSnap.exists) await delReqSnap.ref.delete()

        // ── Delete Firestore user doc ────────────────────────────────────
        await clearPrivateData(uid)
        await db.collection('users').doc(uid).delete()

        // ── Delete Firebase Storage photos ───────────────────────────────
        // Canonical path is photos/{uid}/{spark|play}/... per storage.rules.
        // users/{uid}/ is the legacy prefix kept for any historical objects.
        try {
          const bucket = storage.bucket()
          await bucket.deleteFiles({ prefix: `users/${uid}/` }).catch(() => {})
          await bucket.deleteFiles({ prefix: `photos/${uid}/` }).catch(() => {})
        } catch (storageErr) {
          console.warn(`[onNightlyPurge] Storage delete failed for ${uid}:`, storageErr)
        }

        // ── Delete Firebase Auth account ─────────────────────────────────
        try {
          await auth.deleteUser(uid)
        } catch (authErr: any) {
          if (authErr.code === 'auth/user-not-found') {
            console.warn(`[onNightlyPurge] Auth user ${uid} already deleted.`)
          } else {
            throw authErr
          }
        }

        // ── Log purge event ──────────────────────────────────────────────
        await db.collection('purgeLog').add({
          uid,
          purgedAt: admin.firestore.Timestamp.now(),
          reason: '12_month_retention_expired',
        })

        console.log(`[onNightlyPurge] Successfully purged uid: ${uid}`)

      } catch (err) {
        console.error(`[onNightlyPurge] Failed to purge uid: ${uid}`, err)
        // Continue to next user — don't let one failure block the rest
      }
    }

    console.log(`[onNightlyPurge] Complete. Processed ${snap.size} account(s).`)

    // ── Sweep stale deletedAccounts recovery docs (>18 months, not banned) ──
    // Banned recovery docs never expire — they keep blocking re-signup.
    // 18-month window sits comfortably past the 12-month user-doc purge, so
    // any lineage lookup from restoreAccount/softBlockOnboarding during the
    // user-doc's lifetime still finds the recovery doc.
    const EIGHTEEN_MONTHS_MS = 18 * 30 * 24 * 60 * 60 * 1000
    const eighteenMonthsAgo = admin.firestore.Timestamp.fromMillis(
      Date.now() - EIGHTEEN_MONTHS_MS
    )

    const staleRecovery = await db
      .collection('deletedAccounts')
      .where('deletedAt', '<=', eighteenMonthsAgo)
      .get()

    let recoveryPurged = 0
    let recoveryRetained = 0

    for (const doc of staleRecovery.docs) {
      const data = doc.data()
      if (data.banned === true) {
        recoveryRetained++
        continue
      }
      await doc.ref.delete()
      recoveryPurged++
    }

    console.log(
      `[onNightlyPurge] deletedAccounts sweep: ` +
      `purged=${recoveryPurged}, retained(banned)=${recoveryRetained}`
    )
  }
)

// ─── processGraceExpiredDeletions ────────────────────────────────────────────
// Runs daily at 3am CT (after onNightlyPurge at 2am).
//
// Picks up deletionRequests where status === 'pending' AND scheduledFor has
// passed, then performs the deleteAccount-equivalent soft-delete: writes
// recovery doc to deletedAccounts/{phoneNumber}, anonymizes the user doc,
// deletes the Firebase Auth user. Marks the request 'processed' (or 'error'
// with diagnostic message on failure).
//
// 12 months later, onNightlyPurge picks up the soft-deleted user and runs
// the full hard-delete pass.
//
// phoneNumber is fetched from Firebase Auth, NOT from the deletionRequests
// doc — requestAccountDeletion writes only { uid, requestedAt, scheduledFor,
// reason, status } and never persists the phone.

export const processGraceExpiredDeletions = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'America/Chicago', ...LEGACY_RUNTIME },
  async () => {
    const db = admin.firestore()
    const auth = admin.auth()
    const now = admin.firestore.Timestamp.now()

    const expiredSnap = await db
      .collection('deletionRequests')
      .where('status', '==', 'pending')
      .where('scheduledFor', '<=', now)
      .get()

    console.log(`[graceExpiry] Processing ${expiredSnap.size} expired deletion(s)`)

    for (const reqDoc of expiredSnap.docs) {
      const { uid } = reqDoc.data() as { uid: string }
      try {
        const userRef  = db.collection('users').doc(uid)
        const userSnap = await userRef.get()
        if (!userSnap.exists) {
          await reqDoc.ref.update({ status: 'already_deleted', processedAt: now })
          continue
        }

        // phoneNumber lookup — Auth is source of truth. The deletionRequests
        // doc doesn't carry it. Without a phone we can't write the recovery
        // doc (id keyed by phone), so the request is marked error.
        const authUser    = await auth.getUser(uid).catch(() => null)
        const phoneNumber = authUser?.phoneNumber
        if (!phoneNumber) {
          await reqDoc.ref.update({
            status: 'error',
            lastError: 'no phone number on auth record',
            processedAt: now,
          })
          continue
        }

        const userData = userSnap.data()!

        // Recovery doc — same shape as deleteAccount writes (subset of fields
        // sufficient for restoreAccount to re-inflate identity).
        await db.collection('deletedAccounts').doc(phoneNumber).set({
          previousUid: uid,
          deletedAt:   now,
          banned:      false,
          displayName: userData.displayName,
          photoURLs:   userData.photoURLs ?? [],
          bio:         userData.bio ?? '',
          intent:      userData.intent ?? 'spark',
        })

        // Anonymize the user doc — same anonymization shape deleteAccount uses.
        await userRef.update({
          isDeleted:     true,
          deletedAt:     now,
          displayName:   '[deleted]',
          bio:           '',
          photoURLs:     [],
          locationLabel: '',
          isSuspended:   true,
          ...ROOT_SCRUB,
        })
        await clearPrivateData(uid)

        // Delete the Firebase Auth user. Idempotent — swallow user-not-found.
        await auth.deleteUser(uid).catch(() => {})

        await reqDoc.ref.update({ status: 'processed', processedAt: now })
        console.log(`[graceExpiry] Processed deletion for uid ${uid}`)
      } catch (err) {
        console.error(`[graceExpiry] Failed for uid ${uid}:`, err)
        await reqDoc.ref.update({
          status:    'error',
          lastError: String(err),
          processedAt: now,
        }).catch(() => {})
      }
    }
  }
)
