import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { initializeApp } from 'firebase-admin/app'
import { FieldValue, Timestamp, getFirestore, type DocumentData, type DocumentReference } from 'firebase-admin/firestore'
import { buildBioPrompt, parseBioRequest } from './bioPrompt'
import { scoreToTier, type ZyloveScoreTier } from './shared/zyloveScore'
import {
  FLAG_CATEGORY_IDS,
  MAX_NEGATIVE_DELTA,
  MAX_POSITIVE_DELTA,
  MODERATION_RULES,
  POINTS_PER_NEGATIVE,
  POINTS_PER_POSITIVE,
  REVIEW_TONE,
} from './shared/reviewCategories'
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

// ─── submitReview / processMatchEnd ──────────────────────────────────────────
//
// Three tiers of review category (shared/reviewCategories.ts):
//   positive — applied when the review is submitted
//   neutral  — stored, no score impact
//   negative — held on the review doc and applied only once the match ends
//              (blocked, unmatched or deleted), so the reviewed person can't
//              tie a score drop to an ongoing conversation.
// Review docs carry no revieweeUid, so the reviewee read rule never matches:
// reviews, including pending negatives, stay server-only. Moderation runs at
// submit time regardless of deferral.

const DEFAULT_ZYLOVE_SCORE = 70
// Each applied review is one sample in a rolling average over the last
// SCORE_WINDOW samples. A sample maps the review's delta (−10…+8) onto 0–100
// around the default: +8 → 100, 0 → 70, −10 → 32.5. Mobile's 50 + delta×5
// mapping topped out at 90 with the +8 cap, which made Elite (95) unreachable.
const SAMPLE_PER_POINT = 3.75
const SCORE_WINDOW = 20
const SCORE_HISTORY_LENGTH = 10
const DAY_MS = 24 * 60 * 60 * 1000
const BOT_PREFIXES = ['zbot-', 'seed-']

interface ScoreHistoryPoint {
  delta: number
  score: number
  reason: string
  timestamp: number
}

interface ScoreState {
  score: number
  samples: number
  history: ScoreHistoryPoint[]
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function readScoreState(data: DocumentData): ScoreState {
  return {
    score: num(data.score, DEFAULT_ZYLOVE_SCORE),
    // Docs written before scoreSamples existed had one sample per review.
    samples: num(data.scoreSamples, num(data.reviewCount, 0)),
    history: Array.isArray(data.history) ? data.history : [],
  }
}

function addSample(state: ScoreState, delta: number, reason: string): ScoreState {
  const weight = Math.min(state.samples, SCORE_WINDOW)
  const sample = clamp(DEFAULT_ZYLOVE_SCORE + delta * SAMPLE_PER_POINT, 0, 100)
  const score = Math.round(clamp((state.score * weight + sample) / (weight + 1), 0, 100))
  return {
    score,
    samples: state.samples + 1,
    history: [...state.history, { delta, score, reason, timestamp: Date.now() }].slice(-SCORE_HISTORY_LENGTH),
  }
}

const positiveDelta = (n: number) => Math.min(n * POINTS_PER_POSITIVE, MAX_POSITIVE_DELTA)
const negativeDelta = (n: number) => Math.max(n * POINTS_PER_NEGATIVE, MAX_NEGATIVE_DELTA)

function matchEnded(match: DocumentData): boolean {
  return match.isBlocked === true || (match.unmatchedAt !== undefined && match.unmatchedAt !== null)
}

function topCategories(counts: Record<string, number>): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => id)
}

function parseCategories(data: unknown): string[] {
  const raw = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).categories : undefined
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpsError('invalid-argument', 'Pick at least one category')
  const categories = [...new Set(raw)]
  if (!categories.every((c): c is string => typeof c === 'string' && REVIEW_TONE.has(c))) {
    throw new HttpsError('invalid-argument', 'Unknown review category')
  }
  return categories
}

// Like requireMatchPair, but also accepts matches mobile's unmatch has
// deleted. Their messages survive the delete, and messages can only be
// written by participants while the match exists, so the caller's message
// count check (≥ 1) proves the match was real.
async function requireReviewablePair(matchId: string, callerId: string, otherUid: string): Promise<{ ended: boolean }> {
  if (otherUid === callerId) throw new HttpsError('invalid-argument', 'reviewedUid must be your match')
  const snap = await getFirestore().collection('matches').doc(matchId).get()
  const data = snap.data()
  if (data) {
    const users: unknown = data.users ?? data.participants
    if (!Array.isArray(users) || !users.includes(callerId) || !users.includes(otherUid)) {
      throw new HttpsError('permission-denied', 'Not a participant in this match')
    }
    return { ended: matchEnded(data) }
  }
  if (matchId !== [callerId, otherUid].sort().join('_')) {
    throw new HttpsError('permission-denied', 'Not a participant in this match')
  }
  return { ended: true }
}

// Queues the reviewed user for the safety team once a category crosses its
// threshold. One reviewQueue doc per user and category (admin-only; the same
// collection submitUnmatch writes), never a field on the public users doc.
async function checkModeration(reviewedUid: string, reviewerUid: string, matchId: string, categories: string[]): Promise<void> {
  const rules = MODERATION_RULES.filter((r) => categories.includes(r.category))
  if (rules.length === 0) return
  const db = getFirestore()
  const reviews = await db.collection('reviews').where('reviewedUid', '==', reviewedUid).get()
  const now = Date.now()
  for (const rule of rules) {
    const count = reviews.docs.filter((d) => {
      const r = d.data()
      if (!strings(r.categories).includes(rule.category)) return false
      if (rule.windowDays === null) return true
      const at = r.createdAt instanceof Timestamp ? r.createdAt.toMillis() : now
      return now - at <= rule.windowDays * DAY_MS
    }).length
    if (count < rule.threshold) continue
    await db.collection('reviewQueue').doc(`review_${reviewedUid}_${rule.category}`).set(
      {
        reportedUid: reviewedUid,
        reporterUid: reviewerUid,
        reason: `review_${rule.category}`,
        matchId,
        priority: rule.urgent ? 'urgent' : 'normal',
        flaggedForReview: true,
        urgentReview: rule.urgent,
        count,
        source: 'review',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    logger.warn('submitReview: moderation threshold reached', { category: rule.category, count, urgent: rule.urgent })
  }
}

// One anonymous review per reviewer per match.
export const submitReview = onCall(
  { timeoutSeconds: 30, memory: '128MiB', invoker: 'public' },
  async (request): Promise<{ success: true; newScore: number; newTier: ZyloveScoreTier }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const callerId = request.auth.uid
    const matchId = requireString(request.data, 'matchId')
    const reviewedUid = requireString(request.data, 'reviewedUid')
    const categories = parseCategories(request.data)
    if (BOT_PREFIXES.some((p) => reviewedUid.startsWith(p))) throw new HttpsError('invalid-argument', 'Bots cannot be reviewed')
    const { ended } = await requireReviewablePair(matchId, callerId, reviewedUid)

    const db = getFirestore()
    const messageCount = (await db.collection(`matches/${matchId}/messages`).count().get()).data().count
    if (messageCount < 1) throw new HttpsError('failed-precondition', 'Have a conversation before leaving a review')

    const positive = categories.filter((c) => REVIEW_TONE.get(c) === 'positive')
    const neutral = categories.filter((c) => REVIEW_TONE.get(c) === 'neutral')
    const negative = categories.filter((c) => REVIEW_TONE.get(c) === 'negative')
    const applyNegativeNow = negative.length > 0 && ended
    // A review whose only score impact is still pending stays invisible
    // (not even counted) until the match ends.
    const countedNow = negative.length === 0 || ended || positive.length > 0

    const reviewRef = db.collection('reviews').doc(`${matchId}_${callerId}`)
    const userRef = db.collection('users').doc(reviewedUid)
    const scoreRef = userRef.collection('zyloveScore').doc('current')

    const result = await db.runTransaction(async (tx) => {
      const [existing, scoreSnap, userSnap] = await Promise.all([tx.get(reviewRef), tx.get(scoreRef), tx.get(userRef)])
      if (existing.exists) throw new HttpsError('already-exists', 'You already reviewed this connection')
      if (!userSnap.exists) throw new HttpsError('not-found', 'That profile no longer exists')

      const current = scoreSnap.data() ?? {}
      let state = readScoreState(current)
      if (positive.length > 0) state = addSample(state, positiveDelta(positive.length), 'Positive review')
      if (applyNegativeNow) state = addSample(state, negativeDelta(negative.length), 'Review after a connection ended')
      const reviewCount = num(current.reviewCount, 0) + (countedNow ? 1 : 0)
      const tier = scoreToTier(state.score, reviewCount)
      const positiveCounts: Record<string, number> = { ...(current.positiveCategoryCounts ?? {}) }
      for (const c of positive) positiveCounts[c] = num(positiveCounts[c], 0) + 1

      tx.create(reviewRef, {
        reviewerUid: callerId,
        reviewedUid,
        matchId,
        categories,
        positiveCategories: positive,
        neutralCategories: neutral,
        negativeCategories: negative,
        negativePending: negative.length > 0 && !ended,
        counted: countedNow,
        createdAt: FieldValue.serverTimestamp(),
        ...(applyNegativeNow ? { negativeAppliedAt: FieldValue.serverTimestamp() } : {}),
      })
      tx.set(
        scoreRef,
        {
          uid: reviewedUid,
          score: state.score,
          tier,
          scoreSamples: state.samples,
          history: state.history,
          reviewCount,
          positiveCount: FieldValue.increment(positive.length > 0 ? 1 : 0),
          negativeCount: FieldValue.increment(applyNegativeNow ? 1 : 0),
          flagCount: FieldValue.increment(applyNegativeNow && negative.some((c) => FLAG_CATEGORY_IDS.includes(c)) ? 1 : 0),
          positiveCategoryCounts: positiveCounts,
          topPositiveCategories: topCategories(positiveCounts),
          // Mobile's score screen reads these unguarded (.length on undefined crashes it).
          pendingDisputeCount: num(current.pendingDisputeCount, 0),
          unlockedPerks: Array.isArray(current.unlockedPerks) ? current.unlockedPerks : [],
          lastUpdated: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      tx.update(userRef, { zyloveScoreTier: tier })
      return { newScore: state.score, newTier: tier }
    })

    // After the commit so the count includes this review. A failure here must
    // not fail a saved review, but it is a safety gap, so log it loudly.
    await checkModeration(reviewedUid, callerId, matchId, categories).catch((err: unknown) =>
      logger.error('submitReview: moderation check failed', {
        matchId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )

    logger.info('submitReview', { matchId, positive: positive.length, neutral: neutral.length, negative: negative.length, ended })
    return { success: true, ...result }
  },
)

// Applies one review's held negatives. Idempotent: the transaction re-checks
// negativePending, so retries and repeat triggers apply it once.
async function applyPendingNegative(reviewRef: DocumentReference): Promise<void> {
  const db = getFirestore()
  await db.runTransaction(async (tx) => {
    const review = (await tx.get(reviewRef)).data()
    if (!review || review.negativePending !== true || typeof review.reviewedUid !== 'string') return
    const userRef = db.collection('users').doc(review.reviewedUid)
    const scoreRef = userRef.collection('zyloveScore').doc('current')
    const [scoreSnap, userSnap] = await Promise.all([tx.get(scoreRef), tx.get(userRef)])

    tx.update(reviewRef, { negativePending: false, negativeAppliedAt: FieldValue.serverTimestamp(), counted: true })
    if (!userSnap.exists) return // Deleted account: just clear the pending state.

    const negatives = strings(review.negativeCategories)
    const current = scoreSnap.data() ?? {}
    const state = addSample(readScoreState(current), negativeDelta(negatives.length), 'Review after a connection ended')
    const reviewCount = num(current.reviewCount, 0) + (review.counted === true ? 0 : 1)
    const tier = scoreToTier(state.score, reviewCount)
    tx.set(
      scoreRef,
      {
        uid: review.reviewedUid,
        score: state.score,
        tier,
        scoreSamples: state.samples,
        history: state.history,
        reviewCount,
        negativeCount: FieldValue.increment(1),
        flagCount: FieldValue.increment(negatives.some((c) => FLAG_CATEGORY_IDS.includes(c)) ? 1 : 0),
        topPositiveCategories: Array.isArray(current.topPositiveCategories) ? current.topPositiveCategories : [],
        pendingDisputeCount: num(current.pendingDisputeCount, 0),
        unlockedPerks: Array.isArray(current.unlockedPerks) ? current.unlockedPerks : [],
        lastUpdated: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    tx.update(userRef, { zyloveScoreTier: tier })
  })
}

// Applies held negative reviews when a match ends: blocked (isBlocked),
// unmatched (unmatchedAt), or deleted — mobile's submitUnmatch deletes the
// match doc outright. Fires on every match write, so it returns early unless
// this write is the one that ended the match.
export const processMatchEnd = onDocumentWritten(
  { document: 'matches/{matchId}', timeoutSeconds: 60, memory: '256MiB' },
  async (event) => {
    const before = event.data?.before.data()
    const after = event.data?.after.data()
    if (!before) return
    // Deletion always counts; applyPendingNegative skips anything already applied.
    const endedNow = after === undefined || (matchEnded(after) && !matchEnded(before))
    if (!endedNow) return

    const { matchId } = event.params
    const reviews = await getFirestore().collection('reviews').where('matchId', '==', matchId).get()
    const pending = reviews.docs.filter((d) => d.data().negativePending === true)
    for (const d of pending) await applyPendingNegative(d.ref)
    if (pending.length > 0) logger.info('processMatchEnd: applied held negative reviews', { matchId, count: pending.length })
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
