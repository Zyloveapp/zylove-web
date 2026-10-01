import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { buildBioPrompt, parseBioRequest } from './bioPrompt'

initializeApp()

const anthropicKey = defineSecret('ANTHROPIC_API_KEY')

const MODEL = 'claude-sonnet-4-6'
const MAX_BIO_LENGTH = 500

interface BioResponse {
  bio: string
}

function extractText(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('content' in body)) return ''
  const { content } = body as { content: unknown }
  if (!Array.isArray(content)) return ''
  const first: unknown = content[0]
  if (typeof first !== 'object' || first === null || !('text' in first)) return ''
  const { text } = first as { text: unknown }
  return typeof text === 'string' ? text.trim() : ''
}

// Writes a Spark bio from onboarding answers. Never throws: any failure
// returns an empty bio and the client falls back to its local template.
export const generateSparkBio = onCall(
  { timeoutSeconds: 120, memory: '256MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<BioResponse> => {
    // invoker is public (org policy), so gate spend on a signed-in caller.
    if (!request.auth) return { bio: '' }

    try {
      const input = parseBioRequest(request.data)
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey.value(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 400,
          messages: [{ role: 'user', content: buildBioPrompt(input) }],
        }),
      })

      if (!response.ok) {
        logger.error('generateSparkBio: Anthropic API error', { status: response.status })
        return { bio: '' }
      }

      const bio = extractText(await response.json())
      return { bio: bio.slice(0, MAX_BIO_LENGTH) }
    } catch (err) {
      logger.error('generateSparkBio failed', { message: err instanceof Error ? err.message : String(err) })
      return { bio: '' }
    }
  },
)

// Trust/safety defaults. Firestore rules reject any client write to these, so
// profiles created by the web onboarding lack them — and Discover queries
// isSuspended == false, which never matches a missing field.
const TRUST_DEFAULTS = {
  isSuspended: false,
  reportCount: 0,
  verificationStatus: 'unverified',
  subscriptionTier: 'free',
  sparkScore: 50,
} as const

// Fills in whichever trust/safety fields are missing on the caller's own
// users/{uid} doc. Only missing fields are written, so values set elsewhere
// (e.g. Elite from a founder code) are never overwritten. Idempotent.
export const initUserDefaults = onCall(
  { timeoutSeconds: 30, memory: '128MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')

    const ref = getFirestore().collection('users').doc(request.auth.uid)
    const snap = await ref.get()
    // Never create a stub profile — onboarding must have saved the doc first.
    if (!snap.exists) throw new HttpsError('failed-precondition', 'Profile not found')

    const data = snap.data() ?? {}
    const missing = Object.fromEntries(
      Object.entries(TRUST_DEFAULTS).filter(([field]) => data[field] === undefined),
    )
    if (Object.keys(missing).length > 0) {
      await ref.set(missing, { merge: true })
      logger.info('initUserDefaults: filled missing trust fields', { fields: Object.keys(missing) })
    }
    return { success: true }
  },
)

// ─── likeBack ────────────────────────────────────────────────────────────────

interface LikeBackRequest {
  likerUid: string
  mode: 'spark' | 'play'
}

interface LikeBackResponse {
  matched: true
  matchId: string
}

function parseLikeBackRequest(data: unknown): LikeBackRequest {
  if (typeof data !== 'object' || data === null) throw new HttpsError('invalid-argument', 'Missing request data')
  const { likerUid, mode } = data as Record<string, unknown>
  if (typeof likerUid !== 'string' || !likerUid || likerUid.includes('/')) {
    throw new HttpsError('invalid-argument', 'likerUid required')
  }
  if (mode !== 'spark' && mode !== 'play') throw new HttpsError('invalid-argument', "mode must be 'spark' or 'play'")
  return { likerUid, mode }
}

// Same snapshot shape the mobile app, botEngine and the web client write.
function participantSnapshot(user: DocumentData | undefined): {
  displayName: string
  age: number | null
  photoURL: string | null
} {
  const photos: unknown = user?.photoURLs
  const firstPhoto = Array.isArray(photos) && typeof photos[0] === 'string' ? photos[0] : null
  return {
    displayName: typeof user?.displayName === 'string' && user.displayName ? user.displayName : 'Someone',
    age: typeof user?.age === 'number' && user.age > 0 ? user.age : null,
    photoURL: firstPhoto,
  }
}

// Matches the caller with someone in their like queue ("It's a Spark").
// Being in the queue means the liker already liked the caller, so liking back
// is mutual. Runs with admin privileges so the match is created server-side
// and both queue entries can be removed (rules only allow self-writes).
export const likeBack = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<LikeBackResponse> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const callerId = request.auth.uid
    const { likerUid, mode } = parseLikeBackRequest(request.data)
    if (likerUid === callerId) throw new HttpsError('invalid-argument', 'Cannot like yourself back')

    const db = getFirestore()
    const callerQueueRef = db.doc(`users/${callerId}/likeQueue/${likerUid}`)
    const likerQueueRef = db.doc(`users/${likerUid}/likeQueue/${callerId}`)
    const queueEntry = await callerQueueRef.get()
    if (!queueEntry.exists) throw new HttpsError('not-found', 'No like from this person in your queue')

    const matchId = [callerId, likerUid].sort().join('_')
    const matchRef = db.collection('matches').doc(matchId)

    // Transaction so two taps (or both people at once) create one match.
    const created = await db.runTransaction(async (tx) => {
      const existing = await tx.get(matchRef)
      if (existing.exists) return false
      const [callerSnap, likerSnap] = await Promise.all([
        tx.get(db.collection('users').doc(callerId)),
        tx.get(db.collection('users').doc(likerUid)),
      ])
      if (!likerSnap.exists) throw new HttpsError('not-found', 'That profile no longer exists')
      tx.create(matchRef, {
        matchId,
        users: [callerId, likerUid].sort(),
        mode,
        matchedAt: FieldValue.serverTimestamp(),
        lastMessagePreview: null,
        hasUnread: false,
        isBlocked: false,
        participantSnapshots: {
          [callerId]: participantSnapshot(callerSnap.data()),
          [likerUid]: participantSnapshot(likerSnap.data()),
        },
      })
      return true
    })

    // The like is consumed either way. The liker's entry for the caller may
    // not exist; delete() on a missing doc is a no-op, and a failure here
    // shouldn't undo a match that now exists.
    await callerQueueRef.delete()
    await likerQueueRef.delete().catch((err: unknown) =>
      logger.warn('likeBack: liker queue cleanup failed', { message: err instanceof Error ? err.message : String(err) }),
    )

    logger.info(created ? 'likeBack: match created' : 'likeBack: match already existed', { matchId, mode })
    return { matched: true, matchId }
  },
)
