import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { getStorage } from 'firebase-admin/storage'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'

// Encrypted chat photos sent from the web (messageType 'photo' with
// encryptedKeyForRecipient). The mobile codebase already deploys
// markPhotoViewed / sweepExpiredPhotos for its own photos, so these use
// their own names.
//
// The timer field is photoExpiresAt, not mobile's expiresAt: the messages
// read rule hides docs whose expiresAt has passed from the recipient, which
// would break their whole message query once one photo expired.
//
// Timed photos waiting to be destroyed are tracked in photoExpiries
// (server-only), so the sweep is a single-field query rather than a scan of
// every chat.

const EXPIRIES = 'photoExpiries'
const SWEEP_BATCH = 100

function participants(match: FirebaseFirestore.DocumentData): string[] {
  const users: unknown = match.users ?? match.participants
  return Array.isArray(users) ? users.filter((u): u is string => typeof u === 'string') : []
}

// Recipient's first tap on a photo: stamps firstViewedAt and, for timed
// photos, photoExpiresAt = now + timerSeconds.
export const markChatPhotoViewed = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const data = (request.data ?? {}) as Record<string, unknown>
    const { matchId, messageId } = data
    if (typeof matchId !== 'string' || !matchId || typeof messageId !== 'string' || !messageId) {
      throw new HttpsError('invalid-argument', 'matchId and messageId required')
    }

    const db = getFirestore()
    const matchRef = db.collection('matches').doc(matchId)
    const msgRef = matchRef.collection('messages').doc(messageId)

    await db.runTransaction(async (tx) => {
      const [matchSnap, msgSnap] = await Promise.all([tx.get(matchRef), tx.get(msgRef)])
      if (!matchSnap.exists || !participants(matchSnap.data()!).includes(uid)) {
        throw new HttpsError('permission-denied', 'Not a participant in this match')
      }
      const msg = msgSnap.data()
      if (!msg || msg.messageType !== 'photo') throw new HttpsError('not-found', 'Photo not found')
      // Stage A: only this match's own chat photos start a timer (the sweep
      // deletes what the message points at).
      if (!isChatPhotoOf(matchId, msg.storageRef)) throw new HttpsError('not-found', 'Photo not found')
      if (msg.senderId === uid) throw new HttpsError('failed-precondition', 'Senders cannot mark their own photo viewed')
      if (msg.firstViewedAt != null || msg.destructedAt != null) return // already started (or gone)

      const now = Timestamp.now()
      const timer = typeof msg.timerSeconds === 'number' && msg.timerSeconds > 0 ? msg.timerSeconds : 0
      if (timer === 0) {
        tx.update(msgRef, { firstViewedAt: now })
        return
      }
      const expiresAt = Timestamp.fromMillis(now.toMillis() + timer * 1000)
      tx.update(msgRef, { firstViewedAt: now, photoExpiresAt: expiresAt })
      tx.set(db.collection(EXPIRIES).doc(`${matchId}_${messageId}`), { matchId, messageId, expiresAt })
    })
    return { success: true }
  },
)

// A chat photo of this match: chat-photos/{matchId}/{file}, nothing else.
export function isChatPhotoOf(matchId: string, ref: unknown): ref is string {
  return typeof ref === 'string' && ref.startsWith(`chat-photos/${matchId}/`) && /^[A-Za-z0-9._-]+$/.test(ref.slice(`chat-photos/${matchId}/`.length))
}

// Every 5 minutes: delete expired photos' ciphertext from Storage and strip
// the wrapped keys from the message, so nothing left can be decrypted.
export const sweepChatPhotos = onSchedule(
  { schedule: '*/5 * * * *', timeZone: 'America/Chicago', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db = getFirestore()
    const bucket = getStorage().bucket()
    const due = await db.collection(EXPIRIES).where('expiresAt', '<=', Timestamp.now()).limit(SWEEP_BATCH).get()

    let destroyed = 0
    for (const d of due.docs) {
      const { matchId, messageId } = d.data() as { matchId: string; messageId: string }
      const msgRef = db.doc(`matches/${matchId}/messages/${messageId}`)
      const msg = (await msgRef.get()).data()
      if (msg && msg.destructedAt == null) {
        // Stage A: only ever a file in this match's chat-photos folder — the
        // sender wrote storageRef, and this runs with admin rights.
        if (typeof msg.storageRef === 'string' && msg.storageRef && !isChatPhotoOf(matchId, msg.storageRef)) {
          logger.warn('sweepChatPhotos: storageRef outside the match folder, not deleted', { matchId, messageId })
        } else if (typeof msg.storageRef === 'string' && msg.storageRef) {
          try {
            await bucket.file(msg.storageRef).delete({ ignoreNotFound: true })
          } catch (err) {
            // Leave the expiry record so the next run retries the delete.
            logger.error('sweepChatPhotos: storage delete failed', {
              matchId,
              messageId,
              message: err instanceof Error ? err.message : String(err),
            })
            continue
          }
        }
        await msgRef.update({
          destructedAt: FieldValue.serverTimestamp(),
          storageRef: null,
          photoNonce: FieldValue.delete(),
          encryptedKeyForSender: FieldValue.delete(),
          encryptedKeyForRecipient: FieldValue.delete(),
          keyNonceForSender: FieldValue.delete(),
          keyNonceForRecipient: FieldValue.delete(),
        })
        destroyed++
      }
      await d.ref.delete()
    }
    if (due.size > 0) logger.info('sweepChatPhotos', { due: due.size, destroyed })
  },
)
