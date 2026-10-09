import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { getStorage } from 'firebase-admin/storage'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { SMS_SECRETS, sendSMS, smsTarget } from './sms'
import { storagePath } from './storagePath'
import { requireAdminAudited, audit } from './audit'
import { accountRef, internalRef, isAdminAuth, userRef } from './userData'
import { matchView, type BlocklistMatchView } from './blocklistContext'
import { photoHoldRef, withHoldContext } from './photoHolds'

// Admin photo review (/admin/photos). onPhotoUpload parks flagged photos of
// both modes in users/{uid}/private/account pendingPhotoURLs (owner-only; each
// entry has its mode) and sets userInternal/{uid}.hasPendingPhotos. Accounts
// not yet migrated may still hold Play ones on playProfile/data (readable by
// other users — F-031) or Spark ones on the root doc; both are read too.
// Entries' `url` is the photo's Storage path (older ones: a URL).
// Other users' docs and Storage files are out of a client's reach, so the page
// lists and decides through these admin-gated callables.

type Mode = 'spark' | 'play'

interface PendingEntry {
  url: string
  mode?: unknown
  flaggedAt?: unknown
  reason?: unknown
}

export interface PendingPhoto {
  uid: string
  displayName: string
  mode: Mode
  url: string
  flaggedAt: number | null
  reason: unknown
  // T&S Phase 5: a scam-blocklist hold — which banned account, why, how close.
  blocklistMatch?: BlocklistMatchView
}

const MAX_USERS = 200
const APPROVED_SMS = '✦ Your photo has been approved on Zylove.'
const REJECTED_SMS = 'Your photo was not approved. Please upload a different photo.'

function requireAdmin(auth: { uid: string; token?: Record<string, unknown> } | undefined): string {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.')
  if (!isAdminAuth(auth)) throw new HttpsError('permission-denied', 'Admins only.')
  return auth.uid
}

function pendingOf(data: DocumentData | undefined): PendingEntry[] {
  const raw: unknown = data?.pendingPhotoURLs
  return Array.isArray(raw) ? raw.filter((p): p is PendingEntry => typeof p?.url === 'string' && p.url !== '') : []
}

// The entry's own mode, else the Storage path (photos/{uid}/spark|play/…).
function modeOf(entry: PendingEntry): Mode {
  if (entry.mode === 'spark' || entry.mode === 'play') return entry.mode
  const path = storagePath(entry.url)?.path ?? ''
  return path.startsWith('playPhotos/') || path.includes('/play/') ? 'play' : 'spark'
}

function millis(v: unknown): number | null {
  return v instanceof Timestamp ? v.toMillis() : typeof v === 'number' ? v : null
}

// Moderation notices are account texts: consent, not opted out, the photo's
// mode switched on, not in quiet hours (smsTarget).
async function textUser(uid: string, mode: Mode, body: string): Promise<void> {
  const target = await smsTarget(uid, 'account', mode)
  if (target) await sendSMS(target, body)
}

export const listPendingPhotos = onCall(
  { timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ photos: PendingPhoto[] }> => {
    await requireAdminAudited(request.auth, { action: 'photos.pending_list' })
    const db = getFirestore()
    // Flagged in userInternal; the root-doc flag covers accounts not yet migrated.
    const [flagged, legacy] = await Promise.all([
      db.collection('userInternal').where('hasPendingPhotos', '==', true).limit(MAX_USERS).get(),
      db.collection('users').where('hasPendingPhotos', '==', true).limit(MAX_USERS).get(),
    ])
    const uids = [...new Set([...flagged.docs, ...legacy.docs].map((d) => d.id))]

    const perUser = await Promise.all(
      uids.map(async (uid) => {
        const data = (await userRef(uid).get()).data() ?? {}
        const [account, play] = await Promise.all([accountRef(uid).get(), userRef(uid).collection('playProfile').doc('data').get()])
        const displayName = typeof data.displayName === 'string' ? data.displayName : ''
        return Promise.all(
          [...pendingOf(account.data()), ...pendingOf(data), ...pendingOf(play.data())].map(
            async (entry): Promise<PendingPhoto> => ({
              uid,
              displayName,
              mode: modeOf(entry),
              url: entry.url,
              flaggedAt: millis(entry.flaggedAt),
              // F-071: a blocklist hold's context is kept server-only (photoHolds).
              reason: (await withHoldContext(uid, entry.url, entry.reason)) ?? null,
            }),
          ),
        )
      }),
    )
    // Oldest first: the queue is worked in order.
    const photos = perUser.flat().sort((a, b) => (a.flaggedAt ?? 0) - (b.flaggedAt ?? 0))
    // Blocklist holds: the context stored at hold time, and whether the
    // banned account still has a user doc to open in admin.
    const matched = [...new Set(photos.map((p) => matchView(p.reason, () => false)?.uid).filter((u): u is string => !!u))]
    const onRecord = new Set((await Promise.all(matched.map(async (u) => ((await userRef(u).get()).exists ? u : null)))).filter((u): u is string => !!u))
    for (const p of photos) {
      const view = matchView(p.reason, (u) => onRecord.has(u))
      if (view) p.blocklistMatch = view
    }
    return { photos }
  },
)

// Approve: pending → photoURLs on the doc the photo was flagged on. Reject:
// drop it from pending, delete the file (best effort) and stamp the
// rejection on the root doc, as mobile's rejectPhoto does. Either way the
// user is texted, hasPendingPhotos is cleared once both queues are empty,
// and an adminAudit entry is written.
export const reviewPendingPhoto = onCall(
  { timeoutSeconds: 60, memory: '256MiB', secrets: SMS_SECRETS, invoker: 'public' },
  async (request): Promise<{ status: 'approved' | 'rejected' }> => {
    const adminUid = requireAdmin(request.auth)
    const { targetUid, photoUrl, action } = (request.data ?? {}) as Record<string, unknown>
    if (typeof targetUid !== 'string' || !targetUid || typeof photoUrl !== 'string' || !photoUrl) {
      throw new HttpsError('invalid-argument', 'targetUid and photoUrl are required.')
    }
    if (action !== 'approve' && action !== 'reject') throw new HttpsError('invalid-argument', 'Unknown action.')

    const db = getFirestore()
    const rootRef = userRef(targetUid)
    const acctRef = accountRef(targetUid)
    const playRef = rootRef.collection('playProfile').doc('data')

    const { mode, entry } = await db.runTransaction(async (tx) => {
      const [userSnap, accountSnap, playSnap] = await Promise.all([tx.get(rootRef), tx.get(acctRef), tx.get(playRef)])
      // The queues: private/account (both modes), plus the older homes.
      const queues = [
        { key: 'account' as const, entries: pendingOf(accountSnap.data()) },
        { key: 'root' as const, entries: pendingOf(userSnap.data()) },
        { key: 'play' as const, entries: pendingOf(playSnap.data()) },
      ]
      const source = queues.find((q) => q.entries.some((p) => p.url === photoUrl))
      const found = source?.entries.find((p) => p.url === photoUrl)
      if (!source || !found) throw new HttpsError('not-found', 'That photo is no longer pending.')
      // Older homes decide the mode by where they sit; account entries carry it.
      const where: Mode = source.key === 'root' ? 'spark' : source.key === 'play' ? 'play' : modeOf(found)
      const remaining = source.entries.filter((p) => p.url !== photoUrl)
      const othersLeft = queues.some((q) => q !== source && q.entries.length > 0)

      // Approve: onto the profile of the photo's mode. Reject: stamped on the account.
      if (action === 'approve') tx.update(where === 'spark' ? rootRef : playRef, { photoURLs: FieldValue.arrayUnion(photoUrl) })
      else tx.set(acctRef, { photoRejectedAt: Timestamp.now(), photoRejectionReason: found.reason ?? null }, { merge: true })
      if (source.key === 'account') tx.set(acctRef, { pendingPhotoURLs: remaining }, { merge: true })
      else tx.update(source.key === 'root' ? rootRef : playRef, { pendingPhotoURLs: remaining.length ? remaining : FieldValue.delete() })
      if (remaining.length === 0 && !othersLeft) {
        tx.set(internalRef(targetUid), { hasPendingPhotos: false }, { merge: true })
        if (userSnap.data()?.hasPendingPhotos !== undefined) tx.update(rootRef, { hasPendingPhotos: FieldValue.delete() })
      }
      return { mode: where, entry: found }
    })

    if (action === 'reject') {
      const location = storagePath(entry.url)
      // Only ever this user's own profile photos.
      if (location?.path.startsWith(`photos/${targetUid}/`)) {
        await getStorage()
          .bucket(location.bucket)
          .file(location.path)
          .delete({ ignoreNotFound: true })
          .catch((err) => logger.error('reviewPendingPhoto: Storage delete failed', { message: String(err) }))
      } else {
        logger.warn('reviewPendingPhoto: no deletable Storage path for rejected photo', { targetUid })
      }
    }

    // T&S Phase 1: the one admin audit log (replaces moderationLog). The
    // photo is identified by its mode only, never its URL.
    await audit({ actor: adminUid, action: action === 'approve' ? 'photo.approve' : 'photo.reject', target: targetUid, detail: { mode } })
    // Decided: the hold's kept context (F-071) goes with it.
    await photoHoldRef(targetUid, photoUrl as string).delete().catch(() => {})

    await textUser(targetUid, mode, action === 'approve' ? APPROVED_SMS : REJECTED_SMS).catch((err) =>
      logger.error('reviewPendingPhoto: SMS failed', { message: String(err) }),
    )
    return { status: action === 'approve' ? 'approved' : 'rejected' }
  },
)
