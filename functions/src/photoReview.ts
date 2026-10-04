import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { getStorage } from 'firebase-admin/storage'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { SMS_SECRETS, sendSMS, smsEnabledFor } from './sms'
import { storagePath } from './storagePath'

// Admin photo review (/admin/photos). onPhotoUpload (mobile codebase) parks
// flagged photos in pendingPhotoURLs — on users/{uid} for Spark, on
// users/{uid}/playProfile/data for Play — and sets users/{uid}.hasPendingPhotos.
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
}

const MAX_USERS = 200
const APPROVED_SMS = '✦ Your photo has been approved on Zylove.'
const REJECTED_SMS = 'Your photo was not approved. Please upload a different photo.'

async function requireAdmin(uid: string | undefined): Promise<string> {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.')
  const snap = await getFirestore().doc(`users/${uid}`).get()
  if (snap.data()?.isAdmin !== true) throw new HttpsError('permission-denied', 'Admins only.')
  return uid
}

function pendingOf(data: DocumentData | undefined): PendingEntry[] {
  const raw: unknown = data?.pendingPhotoURLs
  return Array.isArray(raw) ? raw.filter((p): p is PendingEntry => typeof p?.url === 'string' && p.url !== '') : []
}

// The entry's own mode, else the Storage path (photos/{uid}/spark|play/…).
function modeOf(entry: PendingEntry): Mode {
  if (entry.mode === 'spark' || entry.mode === 'play') return entry.mode
  return storagePath(entry.url)?.path.includes('/play/') ? 'play' : 'spark'
}

function millis(v: unknown): number | null {
  return v instanceof Timestamp ? v.toMillis() : typeof v === 'number' ? v : null
}

// Moderation notices are transactional, but still only go to people who
// turned SMS on. sendSMS skips quietly while Twilio isn't configured.
async function textUser(uid: string, user: DocumentData | undefined, mode: Mode, body: string): Promise<void> {
  // The photo's mode decides which master switch applies.
  if (!smsEnabledFor(user?.smsNotificationsEnabled, mode)) return
  const authPhone = await getAuth()
    .getUser(uid)
    .then((u) => u.phoneNumber ?? null)
    .catch(() => null)
  const consentPhone: unknown = user?.smsConsent?.phone
  const phone = authPhone ?? (typeof consentPhone === 'string' ? consentPhone : null)
  if (phone) await sendSMS(phone, body)
}

export const listPendingPhotos = onCall(
  { timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ photos: PendingPhoto[] }> => {
    await requireAdmin(request.auth?.uid)
    const db = getFirestore()
    const users = await db.collection('users').where('hasPendingPhotos', '==', true).limit(MAX_USERS).get()

    const perUser = await Promise.all(
      users.docs.map(async (userDoc) => {
        const data = userDoc.data()
        const play = await userDoc.ref.collection('playProfile').doc('data').get()
        const displayName = typeof data.displayName === 'string' ? data.displayName : ''
        return [...pendingOf(data), ...pendingOf(play.data())].map(
          (entry): PendingPhoto => ({
            uid: userDoc.id,
            displayName,
            mode: modeOf(entry),
            url: entry.url,
            flaggedAt: millis(entry.flaggedAt),
            reason: entry.reason ?? null,
          }),
        )
      }),
    )
    // Oldest first: the queue is worked in order.
    const photos = perUser.flat().sort((a, b) => (a.flaggedAt ?? 0) - (b.flaggedAt ?? 0))
    return { photos }
  },
)

// Approve: pending → photoURLs on the doc the photo was flagged on. Reject:
// drop it from pending, delete the file (best effort) and stamp the
// rejection on the root doc, as mobile's rejectPhoto does. Either way the
// user is texted, hasPendingPhotos is cleared once both queues are empty,
// and a moderationLog row is written.
export const reviewPendingPhoto = onCall(
  { timeoutSeconds: 60, memory: '256MiB', secrets: SMS_SECRETS, invoker: 'public' },
  async (request): Promise<{ status: 'approved' | 'rejected' }> => {
    const adminUid = await requireAdmin(request.auth?.uid)
    const { targetUid, photoUrl, action } = (request.data ?? {}) as Record<string, unknown>
    if (typeof targetUid !== 'string' || !targetUid || typeof photoUrl !== 'string' || !photoUrl) {
      throw new HttpsError('invalid-argument', 'targetUid and photoUrl are required.')
    }
    if (action !== 'approve' && action !== 'reject') throw new HttpsError('invalid-argument', 'Unknown action.')

    const db = getFirestore()
    const userRef = db.doc(`users/${targetUid}`)
    const playRef = userRef.collection('playProfile').doc('data')

    const { mode, entry, user } = await db.runTransaction(async (tx) => {
      const [userSnap, playSnap] = await Promise.all([tx.get(userRef), tx.get(playRef)])
      const sparkPending = pendingOf(userSnap.data())
      const playPending = pendingOf(playSnap.data())
      const inSpark = sparkPending.find((p) => p.url === photoUrl)
      const found = inSpark ?? playPending.find((p) => p.url === photoUrl)
      if (!found) throw new HttpsError('not-found', 'That photo is no longer pending.')
      // Where it sits decides where it goes, whatever the entry says.
      const where: Mode = inSpark ? 'spark' : 'play'
      const remaining = (where === 'spark' ? sparkPending : playPending).filter((p) => p.url !== photoUrl)
      const otherQueue = where === 'spark' ? playPending : sparkPending

      const photoDoc = {
        pendingPhotoURLs: remaining,
        ...(action === 'approve' && { photoURLs: FieldValue.arrayUnion(photoUrl) }),
      }
      const rootFields = {
        ...(remaining.length === 0 && otherQueue.length === 0 && { hasPendingPhotos: false }),
        ...(action === 'reject' && {
          photoRejectedAt: Timestamp.now(),
          photoRejectionReason: found.reason ?? null,
        }),
      }
      if (where === 'spark') {
        tx.update(userRef, { ...photoDoc, ...rootFields })
      } else {
        tx.update(playRef, photoDoc)
        if (Object.keys(rootFields).length > 0) tx.update(userRef, rootFields)
      }
      return { mode: where, entry: found, user: userSnap.data() }
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

    await db.collection('moderationLog').add({
      action: action === 'approve' ? 'approved' : 'rejected',
      photoUrl,
      targetUid,
      adminUid,
      mode,
      source: 'web',
      timestamp: Timestamp.now(),
    })

    await textUser(targetUid, user, mode, action === 'approve' ? APPROVED_SMS : REJECTED_SMS).catch((err) =>
      logger.error('reviewPendingPhoto: SMS failed', { message: String(err) }),
    )
    return { status: action === 'approve' ? 'approved' : 'rejected' }
  },
)
