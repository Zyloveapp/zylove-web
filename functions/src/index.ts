import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { initializeApp } from 'firebase-admin/app'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { buildBioPrompt, parseBioRequest } from './bioPrompt'
import {
  REVIEW_CATEGORIES,
  computeNewScore,
  computeScoreDelta,
  scoreToTier,
  type ReviewCategory,
  type ZyloveScoreTier,
} from './shared/zyloveScore'
import { PLAY_PROMPTS, SPARK_PROMPTS, UNIVERSAL_PROMPTS } from './shared/profile'

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
    // onBotMessage only replies on matches flagged isBot (zbot- isn't in its
    // legacy seed- prefix check).
    const isBot = likerUid.startsWith('zbot-')

    // Transaction so two taps (or both people at once) create one match.
    const created = await db.runTransaction(async (tx) => {
      const existing = await tx.get(matchRef)
      if (existing.exists) {
        // onLike (triggered by the client's like just before this call) may
        // have created the match first, without the bot flag.
        if (isBot && existing.data()?.isBot !== true) tx.update(matchRef, { isBot: true, botUid: likerUid })
        return false
      }
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
        ...(isBot ? { isBot: true, botUid: likerUid } : {}),
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

// ─── Shared match helpers ────────────────────────────────────────────────────

function requireString(data: unknown, field: string): string {
  const value = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[field] : undefined
  if (typeof value !== 'string' || !value || value.includes('/')) {
    throw new HttpsError('invalid-argument', `${field} required`)
  }
  return value
}

// Loads matches/{matchId} and checks that the caller and otherUid are its two
// participants. Callables run with admin privileges, so without this check a
// caller could move any user's score or read any pair of profiles.
async function requireMatchPair(matchId: string, callerId: string, otherUid: string): Promise<void> {
  if (otherUid === callerId) throw new HttpsError('invalid-argument', 'otherUid must be your match')
  const snap = await getFirestore().collection('matches').doc(matchId).get()
  // 'participants' is the legacy name for 'users'.
  const users: unknown = snap.data()?.users ?? snap.data()?.participants
  if (!snap.exists || !Array.isArray(users) || !users.includes(callerId) || !users.includes(otherUid)) {
    throw new HttpsError('permission-denied', 'Not a participant in this match')
  }
}

// ─── recordVibeRating ────────────────────────────────────────────────────────

type VibeRating = 'loving_it' | 'alright' | 'meh'

const VIBE_RATINGS: readonly VibeRating[] = ['loving_it', 'alright', 'meh']
// Asymmetric like mobile's vibeCheck.ts: one bad vibe barely matters.
const VIBE_POINTS: Record<VibeRating, number> = { loving_it: 3, alright: 0, meh: -1 }
const VIBE_COOLDOWN_MS = 24 * 60 * 60 * 1000

// Records the caller's in-chat vibe rating of their match. Ratings are never
// shown to the rated person; only 'loving_it' surfaces, as the match's
// warmSignal. Server-side writes because rules only allow self-writes to
// users/{uid} and deny the vibeChecks collection.
export const recordVibeRating = onCall(
  { timeoutSeconds: 30, memory: '128MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const callerId = request.auth.uid
    const matchId = requireString(request.data, 'matchId')
    const otherUid = requireString(request.data, 'otherUid')
    const rating = (request.data as Record<string, unknown>).rating
    if (!VIBE_RATINGS.includes(rating as VibeRating)) {
      throw new HttpsError('invalid-argument', "rating must be 'loving_it', 'alright' or 'meh'")
    }
    const vibe = rating as VibeRating
    await requireMatchPair(matchId, callerId, otherUid)

    const db = getFirestore()
    const vibeRef = db.collection('vibeChecks').doc(`${matchId}_${callerId}`)
    // The client cooldown lives in localStorage, so enforce it here too —
    // otherwise repeated calls could farm points for a friend.
    const previous = await vibeRef.get()
    const previousAt: unknown = previous.data()?.createdAt
    if (previousAt instanceof Timestamp && Date.now() - previousAt.toMillis() < VIBE_COOLDOWN_MS) {
      throw new HttpsError('resource-exhausted', 'Already rated this conversation in the last 24 hours')
    }

    // update() rather than set(merge) on users/* so a deleted profile fails
    // the batch instead of being recreated as a stub doc.
    const batch = db.batch()
    batch.set(vibeRef, { matchId, raterUid: callerId, rating: vibe, createdAt: FieldValue.serverTimestamp() })
    batch.update(db.collection('matches').doc(matchId), {
      [`lastVibeRating_${callerId}`]: vibe,
      [`lastVibeRatedAt_${callerId}`]: FieldValue.serverTimestamp(),
      ...(vibe === 'loving_it' ? { warmSignal: true } : {}),
    })
    const points = VIBE_POINTS[vibe]
    if (points !== 0) {
      batch.update(db.collection('users').doc(otherUid), { 'zylovScore.vibePoints': FieldValue.increment(points) })
    }
    batch.update(db.collection('users').doc(callerId), { 'zylovScore.participationPoints': FieldValue.increment(1) })
    await batch.commit()

    logger.info('recordVibeRating', { matchId, rating: vibe })
    return { success: true }
  },
)

// ─── setVisibility ───────────────────────────────────────────────────────────

type Visibility = 'active' | 'hidden' | 'paused'

const VISIBILITIES: readonly Visibility[] = ['active', 'hidden', 'paused']

// Sets the caller's per-mode visibility. Writes the same two places mobile's
// pauseControl.ts does: settings/pause (with the paused-at stamp mobile reads)
// and the top-level field Discover filters on.
export const setVisibility = onCall(
  { timeoutSeconds: 15, memory: '128MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const { mode, visibility } = (request.data ?? {}) as Record<string, unknown>
    if (mode !== 'spark' && mode !== 'play') throw new HttpsError('invalid-argument', "mode must be 'spark' or 'play'")
    if (!VISIBILITIES.includes(visibility as Visibility)) {
      throw new HttpsError('invalid-argument', "visibility must be 'active', 'hidden' or 'paused'")
    }

    const db = getFirestore()
    const userRef = db.collection('users').doc(uid)
    if (!(await userRef.get()).exists) throw new HttpsError('failed-precondition', 'Profile not found')

    const field = `${mode}Visibility`
    const batch = db.batch()
    batch.set(
      userRef.collection('settings').doc('pause'),
      {
        [field]: visibility,
        [`${mode}PausedAt`]: visibility === 'active' ? null : Date.now(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    batch.update(userRef, { [field]: visibility })
    await batch.commit()
    return { success: true }
  },
)

// ─── submitReview ────────────────────────────────────────────────────────────

const REVIEW_CATEGORY_META = new Map(REVIEW_CATEGORIES.map((c) => [c.id, c]))
// Mobile's definition of a completed conversation (zyloveScore.ts header).
const MIN_MESSAGES_TO_REVIEW = 5
const DEFAULT_ZYLOVE_SCORE = 70
const SCORE_HISTORY_LENGTH = 10

interface ScoreHistoryPoint {
  delta: number
  score: number
  reason: string
  timestamp: number
}

function parseCategories(data: unknown): ReviewCategory[] {
  const raw = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).categories : undefined
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpsError('invalid-argument', 'Pick at least one category')
  const categories = [...new Set(raw)]
  if (!categories.every((c): c is ReviewCategory => typeof c === 'string' && REVIEW_CATEGORY_META.has(c as ReviewCategory))) {
    throw new HttpsError('invalid-argument', 'Unknown review category')
  }
  return categories
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

// One anonymous post-conversation review per reviewer per match. Updates the
// reviewed user's Zylove Score with mobile's zyloveScore.ts math and flags them
// for moderation once any category crosses its triggersModerationAt count.
// Review docs are written without revieweeUid, so the reviewee read rule never
// matches and reviews stay server-only (a match has one partner, so a readable
// review would name its author).
export const submitReview = onCall(
  { timeoutSeconds: 30, memory: '128MiB', invoker: 'public' },
  async (request): Promise<{ success: true; newScore: number; newTier: ZyloveScoreTier }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const callerId = request.auth.uid
    const matchId = requireString(request.data, 'matchId')
    const reviewedUid = requireString(request.data, 'reviewedUid')
    const categories = parseCategories(request.data)
    await requireMatchPair(matchId, callerId, reviewedUid)

    const db = getFirestore()
    const messageCount = (await db.collection(`matches/${matchId}/messages`).count().get()).data().count
    if (messageCount < MIN_MESSAGES_TO_REVIEW) {
      throw new HttpsError('failed-precondition', 'Have a conversation before leaving a review')
    }

    const reviewRef = db.collection('reviews').doc(`${matchId}_${callerId}`)
    const userRef = db.collection('users').doc(reviewedUid)
    const scoreRef = userRef.collection('zyloveScore').doc('current')
    const delta = computeScoreDelta(categories)

    const result = await db.runTransaction(async (tx) => {
      const [existing, scoreSnap, userSnap] = await Promise.all([tx.get(reviewRef), tx.get(scoreRef), tx.get(userRef)])
      if (existing.exists) throw new HttpsError('already-exists', 'You already reviewed this conversation')
      if (!userSnap.exists) throw new HttpsError('not-found', 'That profile no longer exists')

      const current = scoreSnap.data() ?? {}
      const reviewCount = num(current.reviewCount, 0)
      const newScore = computeNewScore(num(current.score, DEFAULT_ZYLOVE_SCORE), delta, reviewCount)
      const newCount = reviewCount + 1
      const newTier = scoreToTier(newScore, newCount)

      const counts: Record<string, number> = { ...(current.categoryCounts ?? {}) }
      for (const c of categories) counts[c] = num(counts[c], 0) + 1
      const sentiments = categories.map((c) => REVIEW_CATEGORY_META.get(c)?.sentiment)
      const flagged = categories.some((c) => {
        const at = REVIEW_CATEGORY_META.get(c)?.triggersModerationAt ?? 0
        return at > 0 && counts[c] >= at
      })
      const history: ScoreHistoryPoint[] = Array.isArray(current.history) ? current.history : []

      tx.create(reviewRef, {
        reviewerUid: callerId,
        reviewedUid,
        matchId,
        categories,
        flaggedForReview: sentiments.includes('flag'),
        createdAt: FieldValue.serverTimestamp(),
      })
      tx.set(scoreRef, {
        uid: reviewedUid,
        score: newScore,
        tier: newTier,
        reviewCount: FieldValue.increment(1),
        positiveCount: FieldValue.increment(sentiments.includes('positive') ? 1 : 0),
        negativeCount: FieldValue.increment(sentiments.includes('negative') ? 1 : 0),
        flagCount: FieldValue.increment(sentiments.includes('flag') ? 1 : 0),
        categoryCounts: counts,
        // Mobile's score screen reads these unguarded (.length on undefined crashes it).
        topPositiveCategories: [],
        pendingDisputeCount: 0,
        unlockedPerks: [],
        history: [...history, { delta, score: newScore, reason: 'New review received', timestamp: Date.now() }].slice(
          -SCORE_HISTORY_LENGTH,
        ),
        lastUpdated: FieldValue.serverTimestamp(),
      }, { merge: true })
      tx.update(userRef, { zyloveScoreTier: newTier, ...(flagged ? { flaggedForReview: true } : {}) })
      return { newScore, newTier, flagged }
    })

    logger.info('submitReview', { matchId, delta, tier: result.newTier, flagged: result.flagged })
    return { success: true, newScore: result.newScore, newTier: result.newTier }
  },
)

// ─── generateConversationStarter ─────────────────────────────────────────────

const FALLBACK_STARTERS = [
  'What made you swipe right?',
  'What are you looking forward to this week?',
  "What's your go-to first date spot in Austin?",
]
const STARTER_PROMPT_TEXT = new Map(
  [...UNIVERSAL_PROMPTS, ...SPARK_PROMPTS, ...PLAY_PROMPTS].map((p) => [p.id, p.text]),
)

function list(v: unknown): string {
  const items = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
  return items.length > 0 ? items.join(', ') : 'none listed'
}

function promptSummary(v: unknown): string {
  if (!Array.isArray(v)) return 'none'
  const answered = v
    .filter((a): a is { promptId?: unknown; answer: string } => typeof a?.answer === 'string' && a.answer.trim() !== '')
    .map((a) => {
      const prompt = typeof a.promptId === 'string' ? STARTER_PROMPT_TEXT.get(a.promptId) : undefined
      return `${prompt ?? 'Prompt'} "${a.answer.trim().slice(0, 200)}"`
    })
  return answered.length > 0 ? answered.join('; ') : 'none'
}

function personLine(user: DocumentData | undefined): string {
  const name = typeof user?.displayName === 'string' && user.displayName ? user.displayName : 'Someone'
  return `${name}, interests: ${list(user?.lifestyleTags)}, values: ${list(user?.relationshipValues)}, prompts: ${promptSummary(user?.promptAnswers)}`
}

function buildStarterPrompt(me: DocumentData | undefined, them: DocumentData | undefined): string {
  return `Generate 3 short, natural conversation starters for two people who just matched on a dating app.
Person A: ${personLine(me)}
Person B: ${personLine(them)}
Rules: under 15 words each, conversational not formal, based on something specific from their profiles, no generic openers like 'hey' or 'how are you'
Return as JSON array of 3 strings.`
}

function parseStarters(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text.replace(/```json|```/g, '').trim())
    if (!Array.isArray(parsed)) return null
    const starters = parsed
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .map((s) => s.trim().slice(0, 200))
      .slice(0, 3)
    return starters.length > 0 ? starters : null
  } catch {
    return null
  }
}

// "Need a spark?" — three openers for the caller to send their match, written
// from both profiles. Never throws after the participant check: any failure
// returns the fallback starters.
export const generateConversationStarter = onCall(
  { timeoutSeconds: 60, memory: '256MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<{ starters: string[] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const callerId = request.auth.uid
    const matchId = requireString(request.data, 'matchId')
    const otherUid = requireString(request.data, 'otherUid')
    // Gates AI spend and profile reads to the caller's own match.
    await requireMatchPair(matchId, callerId, otherUid)

    try {
      const db = getFirestore()
      const [me, them] = await Promise.all([
        db.collection('users').doc(callerId).get(),
        db.collection('users').doc(otherUid).get(),
      ])
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey.value(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 300,
          messages: [{ role: 'user', content: buildStarterPrompt(me.data(), them.data()) }],
        }),
      })
      if (!response.ok) {
        logger.error('generateConversationStarter: Anthropic API error', { status: response.status })
        return { starters: FALLBACK_STARTERS }
      }
      return { starters: parseStarters(extractText(await response.json())) ?? FALLBACK_STARTERS }
    } catch (err) {
      logger.error('generateConversationStarter failed', { message: err instanceof Error ? err.message : String(err) })
      return { starters: FALLBACK_STARTERS }
    }
  },
)
