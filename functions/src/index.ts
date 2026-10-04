// TODO: Admin dashboard — behavioral metadata, score trends, report patterns, match rates
// Data exists in: users/{uid}.behaviorSignals, users/{uid}.behaviorRiskScore,
// reviewQueue collection, config/launch, publicStats/founding
// Build as /admin route gated on isAdmin: true when Stripe is complete
// (Behavior signals and risk scores actually live server-only in behaviorSignals/{uid}; see behavior.ts.)
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { createHash } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore, type DocumentData, type DocumentReference } from 'firebase-admin/firestore'
import { buildBioPrompt, parseBioRequest } from './bioPrompt'
import { buildPlayBioPrompt, parsePlayBioRequest } from './playBioPrompt'
import { buildPlayReviewPrompt } from './playReviewPrompt'
import {
  PLAY_REVIEW_SECTIONS,
  SECOND_PERSON_RULE,
  SPARK_REVIEW_SECTIONS,
  parseScorecard,
  photoReviewSection,
  scorecardInstructions,
  type ProfileScorecard,
} from './profileScorecard'
import { saveReviewHistory } from './reviewHistory'
import { loadReviewPhotos, photoConsent, type ImageBlock } from './reviewPhotos'
import {
  GO_DEEPER_FOCUS,
  buildPlayGoDeeperPrompt,
  cleanGoDeeperQuestion,
  parsePlayGoDeeperRequest,
} from './playGoDeeperPrompt'
import { SPARK_GO_DEEPER_FOCUS, buildSparkGoDeeperPrompt, parseSparkGoDeeperRequest } from './sparkGoDeeperPrompt'
import { LOOKUP_SECRETS, SMS_SECRETS, claimSparkSmsSlot, lookupLineType, nameFor, sendSMS, smsTarget } from './sms'

export { assignFounderBadge, onLaunchConfigUpdated } from './founders'
export { checkFounderActivity, founderHeartbeat } from './founderActivity'
export { ensureSortKey } from './discovery'
export { mirrorPlayOnlyPhotos } from './playPhotoMirror'
export { listPendingPhotos, reviewPendingPhoto } from './photoReview'
export { adminCityStats, adminListDeletions, adminPurgeAccount } from './adminTools'
export { adminGetActivity, adminUserAction } from './adminActivity'
export { deleteModePhotos } from './profilePhotos'
export { updateDisplayName } from './displayName'
export { processBotLikeBacks, queueBotLikeBack } from './botLikeBack'
import { scoreToTier, type ZyloveScoreTier } from './shared/zyloveScore'
import { recomputeBehaviorRisk, recordVibeSignal } from './behavior'
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
// Same cap as both profile editors (mobile and web).
const MAX_BIO_LENGTH = 300

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

// Cuts at the last whole word that fits, so the text never ends mid-word.
function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  // One extra char shows whether the cut lands exactly on a word boundary.
  const lastSpace = text.slice(0, max + 1).lastIndexOf(' ')
  return (lastSpace > 0 ? text.slice(0, lastSpace) : text.slice(0, max)).trimEnd()
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
      return { bio: truncateAtWord(bio, MAX_BIO_LENGTH) }
    } catch (err) {
      logger.error('generateSparkBio failed', { message: err instanceof Error ? err.message : String(err) })
      return { bio: '' }
    }
  },
)

// Play bio generations allowed per rolling week, per user.
const PLAY_BIO_WEEKLY_LIMIT = 3
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// Successful generations in the last week, from users/{uid}.bioGenerations.play
// (a list of epoch-ms timestamps).
function recentGenerations(data: DocumentData | undefined, now: number): number[] {
  const raw: unknown = data?.bioGenerations?.play
  return Array.isArray(raw) ? raw.filter((t): t is number => typeof t === 'number' && now - t < WEEK_MS) : []
}

// Writes a Play bio from Play onboarding answers. Unlike generateSparkBio this
// is rate limited (3 per rolling week), so hitting the limit is an error the
// client can show; any other failure returns an empty bio.
export const generatePlayBio = onCall(
  { timeoutSeconds: 120, memory: '256MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<BioResponse> => {
    // invoker is public (org policy), so gate spend on a signed-in caller.
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to generate a bio.')
    const userRef = getFirestore().doc(`users/${request.auth.uid}`)

    const snap = await userRef.get()
    if (recentGenerations(snap.data(), Date.now()).length >= PLAY_BIO_WEEKLY_LIMIT) {
      throw new HttpsError('resource-exhausted', 'Play bio generation limit reached. Try again next week.')
    }

    try {
      const input = parsePlayBioRequest(request.data)
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
          messages: [{ role: 'user', content: buildPlayBioPrompt(input) }],
        }),
      })

      if (!response.ok) {
        logger.error('generatePlayBio: Anthropic API error', { status: response.status })
        return { bio: '' }
      }

      const bio = truncateAtWord(extractText(await response.json()), MAX_BIO_LENGTH)
      if (!bio) return { bio: '' }

      // Only successful generations count. Re-checked in the transaction so
      // parallel calls can't record past the limit.
      await getFirestore().runTransaction(async (tx) => {
        const now = Date.now()
        const recent = recentGenerations((await tx.get(userRef)).data(), now)
        tx.set(userRef, { bioGenerations: { play: [...recent, now].slice(-PLAY_BIO_WEEKLY_LIMIT) } }, { merge: true })
      })
      return { bio }
    } catch (err) {
      logger.error('generatePlayBio failed', { message: err instanceof Error ? err.message : String(err) })
      return { bio: '' }
    }
  },
)

// ─── generatePlayGoDeeper ─────────────────────────────────────────────────────

// Go Deeper generations (each one a pair of questions) per rolling week.
const PLAY_GO_DEEPER_WEEKLY_LIMIT = 3
const GO_DEEPER_TEMPERATURES = [0.9, 1.0] as const

function recentGoDeeper(data: DocumentData | undefined, now: number): number[] {
  const raw: unknown = data?.goDeeperGenerations?.play
  return Array.isArray(raw) ? raw.filter((t): t is number => typeof t === 'number' && now - t < WEEK_MS) : []
}

// One question from the shared prompt, or '' on any API failure.
async function askGoDeeper(prompt: string, temperature: number): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey.value(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 100,
      temperature,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!response.ok) {
    logger.error('generatePlayGoDeeper: Anthropic API error', { status: response.status })
    return ''
  }
  return cleanGoDeeperQuestion(extractText(await response.json()))
}

const sameQuestion = (a: string, b: string) => a.toLowerCase().replace(/\W/g, '') === b.toLowerCase().replace(/\W/g, '')

// Two personal Go Deeper questions written from the user's Play answers, one
// after the other: each call has its own focus, and the second is shown the
// first question so it picks a different angle. If they still match, the
// second is asked once more. Rate limited like generatePlayBio — only a
// successful pair counts.
export const generatePlayGoDeeper = onCall(
  { timeoutSeconds: 60, memory: '256MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<{ questions: [string, string] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to generate questions.')
    const userRef = getFirestore().doc(`users/${request.auth.uid}`)

    const snap = await userRef.get()
    if (recentGoDeeper(snap.data(), Date.now()).length >= PLAY_GO_DEEPER_WEEKLY_LIMIT) {
      throw new HttpsError('resource-exhausted', 'Go Deeper limit reached. Try again next week.')
    }

    const input = parsePlayGoDeeperRequest(request.data)
    let first = ''
    let second = ''
    try {
      first = await askGoDeeper(buildPlayGoDeeperPrompt(input, { focus: GO_DEEPER_FOCUS[0] }), GO_DEEPER_TEMPERATURES[0])
      if (first) {
        const secondPrompt = buildPlayGoDeeperPrompt(input, { focus: GO_DEEPER_FOCUS[1], previousQuestion: first })
        second = await askGoDeeper(secondPrompt, GO_DEEPER_TEMPERATURES[1])
        if (second && sameQuestion(first, second)) second = await askGoDeeper(secondPrompt, GO_DEEPER_TEMPERATURES[1])
      }
    } catch (err) {
      logger.error('generatePlayGoDeeper failed', { message: err instanceof Error ? err.message : String(err) })
    }
    if (!first || !second || sameQuestion(first, second)) {
      throw new HttpsError('unavailable', "Couldn't generate questions right now.")
    }

    // Re-checked in the transaction so parallel calls can't record past the limit.
    await getFirestore().runTransaction(async (tx) => {
      const now = Date.now()
      const recent = recentGoDeeper((await tx.get(userRef)).data(), now)
      tx.set(
        userRef,
        { goDeeperGenerations: { play: [...recent, now].slice(-PLAY_GO_DEEPER_WEEKLY_LIMIT) } },
        { merge: true },
      )
    })
    return { questions: [first, second] }
  },
)

// ─── generateSparkGoDeeper ────────────────────────────────────────────────────

const SPARK_GO_DEEPER_WEEKLY_LIMIT = 3

function recentSparkGoDeeper(data: DocumentData | undefined, now: number): number[] {
  const raw: unknown = data?.goDeeperGenerations?.spark
  return Array.isArray(raw) ? raw.filter((t): t is number => typeof t === 'number' && now - t < WEEK_MS) : []
}

// Spark onboarding's Go Deeper: two personal questions from the user's Spark
// answers, same two-call shape as generatePlayGoDeeper (the second sees the
// first so it takes a different angle). 3 successful pairs per rolling week.
export const generateSparkGoDeeper = onCall(
  { timeoutSeconds: 60, memory: '256MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<{ questions: [string, string] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to generate questions.')
    const userRef = getFirestore().doc(`users/${request.auth.uid}`)

    const snap = await userRef.get()
    if (recentSparkGoDeeper(snap.data(), Date.now()).length >= SPARK_GO_DEEPER_WEEKLY_LIMIT) {
      throw new HttpsError('resource-exhausted', 'Go Deeper limit reached. Try again next week.')
    }

    const input = parseSparkGoDeeperRequest(request.data)
    let first = ''
    let second = ''
    try {
      first = await askGoDeeper(
        buildSparkGoDeeperPrompt(input, { focus: SPARK_GO_DEEPER_FOCUS[0] }),
        GO_DEEPER_TEMPERATURES[0],
      )
      if (first) {
        const secondPrompt = buildSparkGoDeeperPrompt(input, { focus: SPARK_GO_DEEPER_FOCUS[1], previousQuestion: first })
        second = await askGoDeeper(secondPrompt, GO_DEEPER_TEMPERATURES[1])
        if (second && sameQuestion(first, second)) second = await askGoDeeper(secondPrompt, GO_DEEPER_TEMPERATURES[1])
      }
    } catch (err) {
      logger.error('generateSparkGoDeeper failed', { message: err instanceof Error ? err.message : String(err) })
    }
    if (!first || !second || sameQuestion(first, second)) {
      throw new HttpsError('unavailable', "Couldn't generate questions right now.")
    }

    await getFirestore().runTransaction(async (tx) => {
      const now = Date.now()
      const recent = recentSparkGoDeeper((await tx.get(userRef)).data(), now)
      tx.set(
        userRef,
        { goDeeperGenerations: { spark: [...recent, now].slice(-SPARK_GO_DEEPER_WEEKLY_LIMIT) } },
        { merge: true },
      )
    })
    return { questions: [first, second] }
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

// Women and other non-male identities get lifetime Elite on the web ('nonbinary'
// is how it's stored). Mobile still elevates only woman / trans_woman.
const ALWAYS_ELITE_IDENTITIES = ['woman', 'trans_woman', 'nonbinary', 'non_binary', 'genderfluid', 'agender', 'self_describe']
const TRIAL_MS = 30 * 24 * 60 * 60 * 1000

// Fills in whichever trust/safety fields are missing on the caller's own
// users/{uid} doc. Only missing fields are written, so values set elsewhere
// (e.g. Elite from a founder code) are never overwritten. Idempotent.
// Also starts the 30-day trial for anyone without one — existing users too,
// since Explore calls this on every load.
export const initUserDefaults = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')

    const ref = getFirestore().collection('users').doc(request.auth.uid)
    const snap = await ref.get()
    // Never create a stub profile — onboarding must have saved the doc first.
    if (!snap.exists) throw new HttpsError('failed-precondition', 'Profile not found')

    const data = snap.data() ?? {}
    const missing: Record<string, unknown> = Object.fromEntries(
      Object.entries(TRUST_DEFAULTS).filter(([field]) => data[field] === undefined),
    )
    if (data.subscriptionTier === undefined) {
      const gender: unknown = Array.isArray(data.genderIdentity) ? data.genderIdentity[0] : data.genderIdentity
      const elite = data.isFounder === true || (typeof gender === 'string' && ALWAYS_ELITE_IDENTITIES.includes(gender))
      missing.subscriptionTier = elite ? 'elite' : 'free'
    }
    // Gender is locked once onboarding is done (rules then refuse changes to
    // birthday, genderIdentity, matchableAs) — Elite comes from gender, so it
    // can't be switched later. Mobile locks at its onboarding step 2.
    if (data.identityLockedAt == null && data.genderIdentity != null) {
      missing.identityLockedAt = FieldValue.serverTimestamp()
    }
    if (data.trialStartedAt === undefined) {
      missing.trialStartedAt = FieldValue.serverTimestamp()
      missing.trialEndsAt = Timestamp.fromMillis(Date.now() + TRIAL_MS)
    }
    // Explore pool position (see discovery.ts): set once, never changed.
    if (typeof data.sortKey !== 'number') missing.sortKey = Math.random()
    if (Object.keys(missing).length > 0) {
      await ref.set(missing, { merge: true })
      logger.info('initUserDefaults: filled missing fields', { fields: Object.keys(missing) })
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
// Returns the match doc's data for callers that need more than the check.
async function requireMatchPair(matchId: string, callerId: string, otherUid: string): Promise<DocumentData> {
  if (otherUid === callerId) throw new HttpsError('invalid-argument', 'otherUid must be your match')
  const snap = await getFirestore().collection('matches').doc(matchId).get()
  // 'participants' is the legacy name for 'users'.
  const users: unknown = snap.data()?.users ?? snap.data()?.participants
  if (!snap.exists || !Array.isArray(users) || !users.includes(callerId) || !users.includes(otherUid)) {
    throw new HttpsError('permission-denied', 'Not a participant in this match')
  }
  return snap.data() ?? {}
}

// ─── recordVibeRating ────────────────────────────────────────────────────────

type VibeRating = 'loving_it' | 'alright' | 'meh'

const VIBE_RATINGS: readonly VibeRating[] = ['loving_it', 'alright', 'meh']
// Asymmetric like mobile's vibeCheck.ts: one bad vibe barely matters.
const VIBE_POINTS: Record<VibeRating, number> = { loving_it: 3, alright: 0, meh: -1 }
// Between ratings of one conversation, by mode (as the web client's cadence).
const VIBE_COOLDOWN_MS = { spark: 24 * 60 * 60 * 1000, play: 12 * 60 * 60 * 1000 } as const
// Both "Loving it" within this window of each other is a mutual vibe.
const MUTUAL_VIBE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// After a 'loving_it': if the partner's latest rating is also 'loving_it',
// recent, and not already part of an earlier mutual, stamp the match
// (mutualVibeAt) — both chats celebrate it once (ChatView). Transactional so
// two near-simultaneous ratings stamp it once.
async function markMutualVibe(matchId: string, otherUid: string): Promise<boolean> {
  const db = getFirestore()
  const ref = db.collection('matches').doc(matchId)
  return db.runTransaction(async (tx) => {
    const m = (await tx.get(ref)).data() ?? {}
    const theirs = m[`lastVibeRating_${otherUid}`]
    const theirAt: unknown = m[`lastVibeRatedAt_${otherUid}`]
    const lastMutual: unknown = m.mutualVibeAt
    if (theirs !== 'loving_it' || !(theirAt instanceof Timestamp)) return false
    if (Date.now() - theirAt.toMillis() > MUTUAL_VIBE_WINDOW_MS) return false
    if (lastMutual instanceof Timestamp && theirAt.toMillis() <= lastMutual.toMillis()) return false
    tx.update(ref, { mutualVibeAt: FieldValue.serverTimestamp(), mutualVibeCount: FieldValue.increment(1) })
    return true
  })
}

// Records the caller's in-chat vibe rating of their match. Ratings are never
// shown to the rated person; only 'loving_it' surfaces, as the match's
// warmSignal. Server-side writes because rules only allow self-writes to
// users/{uid} and deny the vibeChecks collection.
export const recordVibeRating = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
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
    const match = await requireMatchPair(matchId, callerId, otherUid)
    // 'entanglement' is an older name for Play.
    const cooldownMs = match.mode === 'play' || match.mode === 'entanglement' ? VIBE_COOLDOWN_MS.play : VIBE_COOLDOWN_MS.spark

    const db = getFirestore()
    const vibeRef = db.collection('vibeChecks').doc(`${matchId}_${callerId}`)
    // The client cooldown lives in localStorage, so enforce it here too —
    // otherwise repeated calls could farm points for a friend. Admins skip it
    // for testing, but a repeat inside the window moves no scores: the
    // rating is recorded, the points and behaviour signal aren't.
    const [previous, caller] = await Promise.all([vibeRef.get(), db.collection('users').doc(callerId).get()])
    const previousAt: unknown = previous.data()?.createdAt
    const inCooldown = previousAt instanceof Timestamp && Date.now() - previousAt.toMillis() < cooldownMs
    const adminRepeat = inCooldown && caller.data()?.isAdmin === true
    if (inCooldown && !adminRepeat) {
      throw new HttpsError('resource-exhausted', `Already rated this conversation in the last ${cooldownMs / 3_600_000} hours`)
    }

    // update() rather than set(merge) on users/* so a deleted profile fails
    // the batch instead of being recreated as a stub doc.
    const batch = db.batch()
    batch.set(vibeRef, { matchId, raterUid: callerId, rating: vibe, createdAt: FieldValue.serverTimestamp() })
    batch.update(db.collection('matches').doc(matchId), {
      [`lastVibeRating_${callerId}`]: vibe,
      [`lastVibeRatedAt_${callerId}`]: FieldValue.serverTimestamp(),
      // The web client's vibe-check state (its cooldown reads this).
      [`vibeCheckState_${callerId}.lastRatedAt`]: FieldValue.serverTimestamp(),
      ...(vibe === 'loving_it' ? { warmSignal: true } : {}),
    })
    const points = adminRepeat ? 0 : VIBE_POINTS[vibe]
    if (points !== 0) {
      batch.update(db.collection('users').doc(otherUid), { 'zyloveScore.vibePoints': FieldValue.increment(points) })
    }
    if (!adminRepeat) {
      batch.update(db.collection('users').doc(callerId), { 'zyloveScore.participationPoints': FieldValue.increment(1) })
    }
    await batch.commit()
    if (adminRepeat) logger.info('recordVibeRating: admin test repeat, no score change', { matchId })
    if (!adminRepeat && !BOT_PREFIXES.some((p) => otherUid.startsWith(p))) {
      await recordVibeSignal(otherUid, vibe === 'loving_it').catch((err: unknown) =>
        logger.error('recordVibeRating: vibe signal failed', { matchId, message: err instanceof Error ? err.message : String(err) }),
      )
    }

    const mutual =
      vibe === 'loving_it' &&
      (await markMutualVibe(matchId, otherUid).catch((err: unknown) => {
        logger.error('recordVibeRating: mutual check failed', { matchId, message: err instanceof Error ? err.message : String(err) })
        return false
      }))

    // Vibe checks feed the Zylove Score: refresh both people's adjustment now
    // rather than waiting for their next review.
    await Promise.all(
      [otherUid, callerId]
        .filter((uid) => !BOT_PREFIXES.some((p) => uid.startsWith(p)))
        .map((uid) =>
          applyVibeAdjustment(uid).catch((err: unknown) =>
            logger.error('recordVibeRating: vibe adjustment failed', { uid, message: err instanceof Error ? err.message : String(err) }),
          ),
        ),
    )

    logger.info('recordVibeRating', { matchId, rating: vibe, mutual })
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
  { timeoutSeconds: 15, memory: '256MiB', invoker: 'public' },
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

// The rolling review average. Docs from before the vibe adjustment held it
// in score; since then score = reviewScore + vibeAdjustment.
function readScoreState(data: DocumentData): ScoreState {
  return {
    score: num(data.reviewScore, num(data.score, DEFAULT_ZYLOVE_SCORE)),
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

// ─── Vibe adjustment ─────────────────────────────────────────────────────────
// Vibe checks shift the Zylove Score on top of the review average, as a
// separate vibeAdjustment that's recomputed (never accumulated):
//   positive rate ≥ 0.8 → +5, ≥ 0.5 → +2, < 0.3 → −3 (once there are
//   MIN_VIBE_RATINGS ratings, so one rating can't swing it)
//   vibePoints > 10 → +3
// score = clamp(reviewScore + vibeAdjustment, 0, 100).
const MIN_VIBE_RATINGS = 3

// Points from both field names: zyloveScore.* (web functions) and the
// older zylovScore.* that the mobile app still writes.
function vibePointsOf(user: DocumentData | undefined): number {
  return num(user?.zyloveScore?.vibePoints, 0) + num(user?.zylovScore?.vibePoints, 0)
}

function vibeAdjustment(signals: DocumentData | undefined, vibePoints: number): number {
  const ratings = num(signals?.vibeRatings, 0)
  const rate = num(signals?.vibeCheckPositiveRate, 0)
  let adjustment = 0
  if (ratings >= MIN_VIBE_RATINGS) {
    if (rate >= 0.8) adjustment += 5
    else if (rate >= 0.5) adjustment += 2
    else if (rate < 0.3) adjustment -= 3
  }
  if (vibePoints > 10) adjustment += 3
  return adjustment
}

// The displayed score for a review average and the stored adjustment.
function withVibe(reviewScore: number, current: DocumentData): number {
  return Math.round(clamp(reviewScore + num(current.vibeAdjustment, 0), 0, 100))
}

async function applyVibeAdjustment(uid: string): Promise<void> {
  const db = getFirestore()
  const userRef = db.collection('users').doc(uid)
  const scoreRef = userRef.collection('zyloveScore').doc('current')
  const signalsRef = db.collection('behaviorSignals').doc(uid)
  await db.runTransaction(async (tx) => {
    const [userSnap, scoreSnap, signalsSnap] = await Promise.all([tx.get(userRef), tx.get(scoreRef), tx.get(signalsRef)])
    if (!userSnap.exists) return
    const current = scoreSnap.data() ?? {}
    const adjustment = vibeAdjustment(signalsSnap.data(), vibePointsOf(userSnap.data()))
    if (scoreSnap.exists && num(current.vibeAdjustment, 0) === adjustment && current.reviewScore !== undefined) return
    const reviewScore = readScoreState(current).score
    const score = Math.round(clamp(reviewScore + adjustment, 0, 100))
    const reviewCount = num(current.reviewCount, 0)
    const tier = scoreToTier(score, reviewCount)
    tx.set(
      scoreRef,
      {
        uid,
        reviewScore,
        vibeAdjustment: adjustment,
        score,
        tier,
        reviewCount,
        // Mobile's score screen reads these unguarded.
        pendingDisputeCount: num(current.pendingDisputeCount, 0),
        unlockedPerks: Array.isArray(current.unlockedPerks) ? current.unlockedPerks : [],
        topPositiveCategories: Array.isArray(current.topPositiveCategories) ? current.topPositiveCategories : [],
        history: Array.isArray(current.history) ? current.history : [],
        scoreSamples: num(current.scoreSamples, reviewCount),
        lastUpdated: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    tx.update(userRef, { zyloveScoreTier: tier })
  })
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
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
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
      const score = withVibe(state.score, current)
      const tier = scoreToTier(score, reviewCount)
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
          reviewScore: state.score,
          score,
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
      return { newScore: score, newTier: tier }
    })

    // After the commit so the count includes this review. A failure here must
    // not fail a saved review, but it is a safety gap, so log it loudly.
    await checkModeration(reviewedUid, callerId, matchId, categories).catch((err: unknown) =>
      logger.error('submitReview: moderation check failed', {
        matchId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )

    // Safety reports re-score behavior risk now rather than at the 2am run.
    if (categories.some((c) => c === 'felt_unsafe' || c === 'aggressive')) {
      await recomputeBehaviorRisk(reviewedUid).catch((err: unknown) =>
        logger.error('submitReview: behavior risk recompute failed', {
          matchId,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }

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
    const score = withVibe(state.score, current)
    const tier = scoreToTier(score, reviewCount)
    tx.set(
      scoreRef,
      {
        uid: review.reviewedUid,
        reviewScore: state.score,
        score,
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

// Play matches: openers from the Play profiles only (playProfile/data and
// the Play name), never Spark data — the two modes stay sealed.
const PLAY_FALLBACK_STARTERS = [
  "What's the vibe you're hoping for?",
  'What caught your eye on my profile?',
  "What's your idea of a good first meet?",
]

function playPersonLine(root: DocumentData | undefined, play: DocumentData | undefined): string {
  const name =
    [root?.playDisplayName, play?.displayName].find((n): n is string => typeof n === 'string' && n.trim() !== '') ?? 'Someone'
  const bio = typeof play?.playBio === 'string' && play.playBio.trim() ? `"${play.playBio.trim().slice(0, 200)}"` : 'none'
  const spice = typeof play?.spiceLevel === 'string' ? play.spiceLevel : 'unknown'
  return `${name}, Play bio: ${bio}, spice level: ${spice}, into: ${list(play?.playInterestTags)}, prompts: ${promptSummary(play?.promptAnswers)}`
}

function buildPlayStarterPrompt(lines: [string, string]): string {
  return `Generate 3 short, natural opening messages for two adults who just matched in the casual, flirty "Play" side of a dating app.
Person A: ${lines[0]}
Person B: ${lines[1]}
Rules: under 15 words each, playful and confident, flirty but tasteful and respectful — nothing explicit or graphic, consent-minded, based on something specific from their Play profiles, no generic openers like 'hey' or 'how are you'
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

// "Need a spark?" (Play: "Need inspiration? 🔥") — three openers for the
// caller to send their match, written from both profiles of the match's mode.
// Never throws after the participant check: any failure returns the
// fallback starters.
export const generateConversationStarter = onCall(
  { timeoutSeconds: 60, memory: '256MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<{ starters: string[] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const callerId = request.auth.uid
    const matchId = requireString(request.data, 'matchId')
    const otherUid = requireString(request.data, 'otherUid')
    // Gates AI spend and profile reads to the caller's own match.
    const match = await requireMatchPair(matchId, callerId, otherUid)
    const play = match.mode === 'play'
    const fallback = play ? PLAY_FALLBACK_STARTERS : FALLBACK_STARTERS

    try {
      const db = getFirestore()
      const [me, them, myPlay, theirPlay] = await Promise.all([
        db.collection('users').doc(callerId).get(),
        db.collection('users').doc(otherUid).get(),
        play ? db.doc(`users/${callerId}/playProfile/data`).get() : Promise.resolve(null),
        play ? db.doc(`users/${otherUid}/playProfile/data`).get() : Promise.resolve(null),
      ])
      const prompt = play
        ? buildPlayStarterPrompt([playPersonLine(me.data(), myPlay?.data()), playPersonLine(them.data(), theirPlay?.data())])
        : buildStarterPrompt(me.data(), them.data())
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
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!response.ok) {
        logger.error('generateConversationStarter: Anthropic API error', { status: response.status, play })
        return { starters: fallback }
      }
      return { starters: parseStarters(extractText(await response.json())) ?? fallback }
    } catch (err) {
      logger.error('generateConversationStarter failed', { play, message: err instanceof Error ? err.message : String(err) })
      return { starters: fallback }
    }
  },
)

// ─── Profile AI: shared helpers ──────────────────────────────────────────────

// One-turn Claude call. Returns '' on any API failure (logged); callers fall back.
async function askClaude(label: string, prompt: string, maxTokens: number): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey.value(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!response.ok) {
    logger.error(`${label}: Anthropic API error`, { status: response.status })
    return ''
  }
  return extractText(await response.json())
}

// A profile review: the photos (if any) first, then the prompt.
async function askClaudeWithPhotos(label: string, prompt: string, photos: ImageBlock[], maxTokens: number): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey.value(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: [...photos, { type: 'text', text: prompt }] }],
    }),
  })
  if (!response.ok) {
    logger.error(`${label}: Anthropic API error`, { status: response.status })
    return ''
  }
  return extractText(await response.json())
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ')
}

function humanList(v: unknown): string {
  return strings(v).map(humanizeKey).join(', ') || 'none listed'
}

interface OwnAnswer {
  question: string
  answer: string
}

// Prompt answers from wherever this profile keeps them: sparkProfile/data's
// sparkPromptAnswers map (web) or promptAnswers array, else the root doc.
function ownPromptAnswers(root: DocumentData, spark: DocumentData): OwnAnswer[] {
  const fromList = (v: unknown) =>
    Array.isArray(v)
      ? v
          .filter((a) => typeof a?.promptId === 'string' && typeof a?.answer === 'string' && a.answer.trim())
          .map((a) => ({ promptId: a.promptId as string, answer: (a.answer as string).trim() }))
      : []
  const map: unknown = spark.sparkPromptAnswers
  const fromMap =
    typeof map === 'object' && map !== null && !Array.isArray(map)
      ? Object.entries(map)
          .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '')
          .map(([promptId, answer]) => ({ promptId, answer: answer.trim() }))
      : []
  const raw = fromMap.length > 0 ? fromMap : fromList(spark.promptAnswers).length > 0 ? fromList(spark.promptAnswers) : fromList(root.promptAnswers)
  const dynamic = typeof spark.dynamicPrompt === 'string' ? spark.dynamicPrompt : typeof root.dynamicPrompt === 'string' ? root.dynamicPrompt : ''
  return raw.map((a) => ({
    question: a.promptId === 'dynamic' && dynamic ? dynamic : (STARTER_PROMPT_TEXT.get(a.promptId) ?? humanizeKey(a.promptId)),
    answer: a.answer,
  }))
}

async function loadOwnProfileDocs(uid: string): Promise<{ root: DocumentData; spark: DocumentData }> {
  const db = getFirestore()
  const [root, spark] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.doc(`users/${uid}/sparkProfile/data`).get(),
  ])
  if (!root.exists) throw new HttpsError('failed-precondition', 'Profile not found')
  return { root: root.data() ?? {}, spark: spark.data() ?? {} }
}

function ownBio(root: DocumentData, spark: DocumentData): string {
  // Mobile's editor saves the bio only to sparkProfile/data.
  const bio = typeof spark.bio === 'string' && spark.bio.trim() ? spark.bio : root.bio
  return typeof bio === 'string' ? bio.trim() : ''
}

// ─── generateProfileQuestion ─────────────────────────────────────────────────

const QUESTION_FALLBACKS: Record<string, string> = {
  ambitious: 'What does building something meaningful look like to you?',
  creative: "What's the last thing you made that you're proud of?",
  adventurous: "What's the trip that changed how you see things?",
}
const DEFAULT_QUESTION = "What's something most people don't know about you?"

function cleanQuestion(text: string): string | null {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const q = line.replace(/^["'“”]+|["'“”]+$/g, '').trim()
  return q.length >= 10 && q.length <= 150 && q.endsWith('?') ? q : null
}

// A "✦ Just for you" prompt question written from the caller's own profile.
// Never throws after the auth check: failures return a trait-based fallback.
export const generateProfileQuestion = onCall(
  { timeoutSeconds: 60, memory: '256MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<{ question: string }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    let fallback = DEFAULT_QUESTION
    try {
      const { root, spark } = await loadOwnProfileDocs(uid)
      fallback = QUESTION_FALLBACKS[strings(root.personalityTraits)[0] ?? ''] ?? DEFAULT_QUESTION
      const answered = ownPromptAnswers(root, spark).map((a) => a.question)
      const prompt = `Based on this person's dating profile, generate ONE unique, thoughtful question they could answer to help potential matches understand them better. The question should be specific to their actual interests, values and personality — not generic. It should be something that reveals character and sparks conversation.

Profile: Name: ${typeof root.displayName === 'string' ? root.displayName : 'Unknown'}, Personality: ${humanList(root.personalityTraits)}, Values: ${humanList(root.relationshipValues)}, Lifestyle: ${humanList(root.lifestyleTags)}, Bio: ${ownBio(root, spark) || 'none'}, Prompts already answered: ${answered.join(' | ') || 'none'}

Rules: under 12 words, conversational, specific to this person, not a question they already answered, no yes/no questions.
Return only the question text, nothing else.`
      return { question: cleanQuestion(await askClaude('generateProfileQuestion', prompt, 100)) ?? fallback }
    } catch (err) {
      logger.error('generateProfileQuestion failed', { message: err instanceof Error ? err.message : String(err) })
      return { question: fallback }
    }
  },
)

// ─── reviewProfile ───────────────────────────────────────────────────────────

// The fields a match actually sees — never birthday, contact or location data.
function profileForReview(root: DocumentData, spark: DocumentData): string {
  const photoCount = strings(root.photoURLs).length
  const answers = ownPromptAnswers(root, spark)
  const gender = Array.isArray(root.genderIdentity) ? root.genderIdentity[0] : root.genderIdentity
  return [
    `Name: ${typeof root.displayName === 'string' ? root.displayName : 'Unknown'}`,
    typeof root.age === 'number' ? `Age: ${root.age}` : '',
    typeof gender === 'string' ? `Gender: ${humanizeKey(gender)}` : '',
    `Photos: ${photoCount}`,
    `Bio: ${ownBio(root, spark) || 'none'}`,
    `Open to: ${humanList(root.openTo)}`,
    `Personality: ${humanList(root.personalityTraits)}`,
    `Values: ${humanList(root.relationshipValues)}`,
    `Lifestyle: ${humanList(root.lifestyleTags)}`,
    `Habits: ${humanList(root.habitTags)}`,
    `Weekends: ${humanList(root.weekendVibes)}`,
    `Love languages (gives): ${humanList(root.loveLangGive)}; (receives): ${humanList(root.loveLangReceive)}`,
    typeof root.conflictStyle === 'string' ? `Conflict style: ${humanizeKey(root.conflictStyle)}` : '',
    typeof root.togethernessStyle === 'string' ? `Together time: ${humanizeKey(root.togethernessStyle)}` : '',
    typeof root.stressResponse === 'string' ? `Under stress: ${humanizeKey(root.stressResponse)}` : '',
    answers.length > 0 ? `Prompts:\n${answers.map((a) => `- ${a.question} "${a.answer.slice(0, 200)}"`).join('\n')}` : 'Prompts: none',
  ]
    .filter(Boolean)
    .join('\n')
}

// Scorecard JSON runs past the old prose limit; leave headroom so a long
// reply isn't cut mid-object (which would fail the parse).
const REVIEW_MAX_TOKENS = 1000
// Room for the photos block on top of the scorecard.
const REVIEW_WITH_PHOTOS_MAX_TOKENS = 1400

// "How's my profile?" — honest AI scorecard for the caller's own Spark
// profile, with photo coaching when they opted in
// (photoAnalysisConsent.spark). A reply that isn't the expected JSON is an
// error the client shows with a Regenerate button.
export const reviewProfile = onCall(
  { timeoutSeconds: 120, memory: '512MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<{ review: ProfileScorecard }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    let review: ProfileScorecard | null = null
    try {
      const { root, spark } = await loadOwnProfileDocs(request.auth.uid)
      const photos = photoConsent(root, 'spark') ? await loadReviewPhotos(request.auth.uid, root.photoURLs) : []
      const prompt = `Review this dating profile on Zylove Spark — serious dating, real compatibility. Give honest, constructive feedback. Be direct but kind.

Profile:
${profileForReview(root, spark)}

── REVIEW GUIDELINES ──
Score and review these four sections:

- Clarity — Is it clear who they are and what they're looking for?
- Authenticity — Does it sound like a real, specific person rather than a template?
- Depth — Do the prompts and answers reveal values, character and how they love?
- Appeal — Will this draw in the kind of person they want? What's working well?

Then give the single most impactful change they could make as the top suggestion.
${photos.length > 0 ? `\n${photoReviewSection('spark', photos.length)}\n` : ''}
── RULES ──
- Be honest, not flattering — scores should be earned
- Be specific to their actual profile, not generic advice

${SECOND_PERSON_RULE}

${scorecardInstructions(SPARK_REVIEW_SECTIONS, { photos: photos.length > 0 })}`
      const maxTokens = photos.length > 0 ? REVIEW_WITH_PHOTOS_MAX_TOKENS : REVIEW_MAX_TOKENS
      const reply = await askClaudeWithPhotos('reviewProfile', prompt, photos, maxTokens)
      review = parseScorecard(reply, SPARK_REVIEW_SECTIONS, { photos: photos.length > 0 })
    } catch (err) {
      logger.error('reviewProfile failed', { message: err instanceof Error ? err.message : String(err) })
    }
    if (!review) throw new HttpsError('unavailable', "Couldn't generate review. Try again.")
    await saveReviewHistory(request.auth.uid, 'spark', review)
    return { review }
  },
)

// ─── reviewPlayProfile ───────────────────────────────────────────────────────

const PLAY_REVIEW_WEEKLY_LIMIT = 3

// Successful Play reviews in the last week (users/{uid}.profileReviews.play).
function recentPlayReviews(data: DocumentData | undefined, now: number): number[] {
  const raw: unknown = data?.profileReviews?.play
  return Array.isArray(raw) ? raw.filter((t): t is number => typeof t === 'number' && now - t < WEEK_MS) : []
}

// "How's my Play profile? 🔥" — a scorecard for the caller's saved Play
// profile, with photo coaching when they opted in (photoAnalysisConsent.play).
// 3 per rolling week; only successful reviews count.
export const reviewPlayProfile = onCall(
  { timeoutSeconds: 120, memory: '512MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<{ review: ProfileScorecard }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const db = getFirestore()
    const userRef = db.doc(`users/${request.auth.uid}`)
    const [userSnap, playSnap] = await Promise.all([userRef.get(), userRef.collection('playProfile').doc('data').get()])
    if (recentPlayReviews(userSnap.data(), Date.now()).length >= PLAY_REVIEW_WEEKLY_LIMIT) {
      throw new HttpsError('resource-exhausted', 'Play profile review limit reached. Try again next week.')
    }
    if (!playSnap.exists) throw new HttpsError('failed-precondition', 'Set up your Play profile first.')

    const play = playSnap.data() ?? {}
    const photos = photoConsent(userSnap.data(), 'play') ? await loadReviewPhotos(request.auth.uid, play.photoURLs) : []
    const reply = await askClaudeWithPhotos(
      'reviewPlayProfile',
      buildPlayReviewPrompt(play, photos.length),
      photos,
      photos.length > 0 ? REVIEW_WITH_PHOTOS_MAX_TOKENS : REVIEW_MAX_TOKENS,
    )
    const review = parseScorecard(reply, PLAY_REVIEW_SECTIONS, { photos: photos.length > 0 })
    // Unparseable replies don't count toward the weekly limit.
    if (!review) {
      logger.error('reviewPlayProfile: reply was not a valid scorecard', { length: reply.length })
      throw new HttpsError('unavailable', "Couldn't generate review. Try again.")
    }
    await db.runTransaction(async (tx) => {
      const now = Date.now()
      const recent = recentPlayReviews((await tx.get(userRef)).data(), now)
      tx.set(userRef, { profileReviews: { play: [...recent, now].slice(-PLAY_REVIEW_WEEKLY_LIMIT) } }, { merge: true })
    })
    await saveReviewHistory(request.auth.uid, 'play', review)
    return { review }
  },
)

// ─── getSentSparks ───────────────────────────────────────────────────────────

interface SentSpark {
  uid: string
  displayName: string
  age: number | null
  photoURL: string | null
  sparkScore: number | null
  playScore: number | null
  tier1Spark: unknown
  likedAt: number
}

const SENT_LIMIT = 100

function toMillis(v: unknown): number {
  if (typeof v === 'number') return v
  return v instanceof Timestamp ? v.toMillis() : 0
}

// The caller's outgoing likes that haven't become links, for the Sparks
// "Sent" tab. A like lives only as pairs/{a_b}.userXLiked, and the client
// rules can't list pairs (they key on the doc id), so this runs server-side.
// The mode comes from the like-queue entry the like wrote; whether the other
// person passed is never revealed — pending is pending.
export const getSentSparks = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ sent: SentSpark[] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const mode = (request.data as Record<string, unknown> | null)?.mode === 'play' ? 'play' : 'spark'
    const db = getFirestore()
    const pairs = db.collection('pairs')

    const [asA, asB] = await Promise.all([
      pairs.where('userA', '==', uid).where('userALiked', '==', true).where('matched', '==', false).limit(SENT_LIMIT).get(),
      pairs.where('userB', '==', uid).where('userBLiked', '==', true).where('matched', '==', false).limit(SENT_LIMIT).get(),
    ])

    const sent = await Promise.all(
      [...asA.docs, ...asB.docs].map(async (pairSnap): Promise<SentSpark | null> => {
        const pair = pairSnap.data()
        const otherUid: unknown = pair.userA === uid ? pair.userB : pair.userA
        if (typeof otherUid !== 'string') return null
        const [matchSnap, userSnap, queueSnap] = await Promise.all([
          db.collection('matches').doc(pairSnap.id).get(),
          db.collection('users').doc(otherUid).get(),
          db.doc(`users/${otherUid}/likeQueue/${uid}`).get(),
        ])
        // likeBack creates matches without flipping pairs.matched.
        if (matchSnap.exists) return null
        const user = userSnap.data()
        if (!user || user.isSuspended === true) return null
        const queue = queueSnap.data()
        if (queue && (queue.mode === 'play' ? 'play' : 'spark') !== mode) return null
        const photos: unknown = user.photoURLs
        return {
          uid: otherUid,
          displayName: typeof user.displayName === 'string' && user.displayName ? user.displayName : 'Someone',
          age: typeof user.age === 'number' && user.age > 0 ? user.age : null,
          photoURL: Array.isArray(photos) && typeof photos[0] === 'string' ? photos[0] : null,
          sparkScore: typeof pair.sparkScore === 'number' ? pair.sparkScore : null,
          playScore: typeof pair.playScore === 'number' ? pair.playScore : null,
          tier1Spark: pair.tier1Spark ?? null,
          likedAt: toMillis(queue?.likedAt) || toMillis(pair.createdAt),
        }
      }),
    )

    return { sent: sent.filter((s): s is SentSpark => s !== null).sort((a, b) => b.likedAt - a.likedAt) }
  },
)

// ─── getCuriousVisitors ──────────────────────────────────────────────────────

interface CuriousVisitor {
  uid: string
  displayName: string
  age: number | null
  photoURL: string | null
  locationLabel: string | null
  intent: string | null
  sparkScore: number | null
  playScore: number | null
  tier1Spark: unknown
  at: number
}

const CURIOUS_LIMIT = 20

// Mirrors isWomanIdentity in the web app's subscription.ts. genderIdentity is
// a string from Spark onboarding, an array from Play.
function isWoman(genderIdentity: unknown): boolean {
  const g = Array.isArray(genderIdentity) ? genderIdentity[0] : genderIdentity
  if (typeof g !== 'string') return false
  const v = g.toLowerCase().trim()
  return v === 'woman' || v === 'cis woman' || v === 'trans_woman'
}

// When the other person in a pair (not `uid`) revealed the score.
function revealedAt(pair: DocumentData, uid: string): number {
  const otherUid = pair.userA === uid ? pair.userB : pair.userA
  return toMillis(pair[`${otherUid}_revealedAt`]) || toMillis(pair.createdAt)
}

// "Curious" — people who actually looked at your compatibility score: the
// pair doc carries {theirUid}_revealed, written by the web client when they
// tap "Reveal your score" or open a view that shows the full report (the
// background prefetch doesn't count). Excludes anyone you've liked or linked with, and anyone who liked you
// (they're in Sparks, where an unmatched liker's name stays hidden — showing
// them here would unmask them). Women and Elite get the list; everyone else
// gets only the count, enforced here so the list can't be fetched directly.
export const getCuriousVisitors = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ locked: boolean; count: number; visitors: CuriousVisitor[] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const db = getFirestore()

    const [me, asA, asB] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('pairs').where('userA', '==', uid).get(),
      db.collection('pairs').where('userB', '==', uid).get(),
    ])
    const unlocked = isWoman(me.data()?.genderIdentity) || me.data()?.subscriptionTier === 'elite'

    const candidates = [...asA.docs, ...asB.docs]
      .map((d) => ({ id: d.id, pair: d.data() }))
      .filter(({ pair }) => {
        const iAmA = pair.userA === uid
        const otherUid = iAmA ? pair.userB : pair.userA
        if (typeof otherUid !== 'string' || pair[`${otherUid}_revealed`] !== true) return false
        if (pair.matched === true) return false
        // Neither side has liked: I haven't, and they haven't (Sparks covers that).
        return pair.userALiked !== true && pair.userBLiked !== true
      })
      .sort((a, b) => revealedAt(b.pair, uid) - revealedAt(a.pair, uid))

    const visitors: CuriousVisitor[] = []
    for (const { id, pair } of candidates) {
      if (visitors.length >= CURIOUS_LIMIT) break
      const otherUid: string = pair.userA === uid ? pair.userB : pair.userA
      const [matchSnap, userSnap] = await Promise.all([
        db.collection('matches').doc(id).get(),
        db.collection('users').doc(otherUid).get(),
      ])
      const user = userSnap.data()
      if (matchSnap.exists || !user || user.isSuspended === true) continue
      const photos: unknown = user.photoURLs
      visitors.push({
        uid: otherUid,
        displayName: typeof user.displayName === 'string' && user.displayName ? user.displayName : 'Someone',
        age: typeof user.age === 'number' && user.age > 0 ? user.age : null,
        photoURL: Array.isArray(photos) && typeof photos[0] === 'string' ? photos[0] : null,
        locationLabel: typeof user.locationLabel === 'string' && user.locationLabel ? user.locationLabel : null,
        intent: typeof user.intent === 'string' ? user.intent : null,
        sparkScore: typeof pair.sparkScore === 'number' ? pair.sparkScore : null,
        playScore: typeof pair.playScore === 'number' ? pair.playScore : null,
        tier1Spark: pair.tier1Spark ?? null,
        at: revealedAt(pair, uid),
      })
    }

    return unlocked
      ? { locked: false, count: visitors.length, visitors }
      : { locked: true, count: visitors.length, visitors: [] }
  },
)

// Bot chats: "typing…" while a bot reply is on its way (see botTyping.ts).
export { botTypingStart, botTypingStop } from './botTyping'
export { computeBehaviorScore, getPastConnections, onMatchBehaviorUpdate } from './behavior'
export { markChatPhotoViewed, sweepChatPhotos } from './photos'
export { checkTrialStatus } from './trial'
export { createCheckoutSession, createPortalSession, stripeWebhook } from './stripe'
export {
  broadcastToFounders,
  getFounderThread,
  getFounderThreads,
  markFounderThreadRead,
  replyToFounder,
  sendFounderMessage,
} from './founderMessages'
export { acceptPhotoConsent, getBlockedUsers, onBeforeSignIn, reportAndBan, unblockMember } from './trust'

// ─── SMS notifications ───────────────────────────────────────────────────────
// Opt-in texts (Settings → Notifications). Each checks the recipient's
// master switch for that mode (smsNotificationsEnabled.spark|play), the per-kind preference and their quiet
// hours (a text in quiet hours is dropped, not delayed); sendSMS
// never throws, so a texting problem never affects the write that fired it.

const MESSAGE_SMS_COOLDOWN_MS = 5 * 60 * 1000
const NUDGE_COOLDOWN_MS = 48 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function millis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis()
  return typeof v === 'number' ? v : null
}

function participantsOf(match: DocumentData | undefined): string[] {
  const users: unknown = match?.users ?? match?.participants
  return Array.isArray(users) ? users.filter((u): u is string => typeof u === 'string') : []
}

// New Spark: someone landed in this user's like queue. Anonymous on purpose:
// the app only names a liker once it's a match (or a bot). At most one every
// 4 hours per user.
export const smsOnSpark = onDocumentCreated(
  { document: 'users/{uid}/likeQueue/{likerUid}', secrets: SMS_SECRETS },
  async (event) => {
    const play = event.data?.data()?.mode === 'play'
    const target = await smsTarget(event.params.uid, 'newSpark', play ? 'play' : 'spark')
    if (!target || !(await claimSparkSmsSlot(target.uid))) return
    await sendSMS(
      target.phone,
      play
        ? "🔥 Someone's interested on Zylove Play. Check your Flames. zylove.app/sparks"
        : '✦ Someone feels a Spark with you on Zylove. Open your Sparks to see more. zylove.app/sparks',
    )
  },
)

// New message: texts the other participant, at most once per match every
// 5 minutes. Protocol and system messages don't count, and neither do bot
// chats — a bot reply never texts anyone.
export const smsOnMessage = onDocumentCreated(
  { document: 'matches/{matchId}/messages/{messageId}', secrets: SMS_SECRETS },
  async (event) => {
    const msg = event.data?.data()
    if (!msg) return
    const senderId: unknown = msg.senderId
    if (typeof senderId !== 'string' || !senderId) return
    const ciphertext = typeof msg.ciphertext === 'string' ? msg.ciphertext : ''
    if (
      msg.isBot === true ||
      senderId.startsWith('zbot-') ||
      senderId.startsWith('seed-') ||
      msg.nonce === 'system' ||
      msg.messageType === 'system' ||
      msg.messageType === 'consent_request' ||
      ciphertext.startsWith('photo_consent')
    ) {
      return
    }

    const db = getFirestore()
    const matchRef = db.doc(`matches/${event.params.matchId}`)
    const match = (await matchRef.get()).data()
    if (!match || match.isBlocked === true || match.isBot === true) return
    const recipientUid = participantsOf(match).find((u) => u !== senderId)
    if (!recipientUid) return

    const target = await smsTarget(recipientUid, 'newMessage', match.mode === 'play' ? 'play' : 'spark')
    if (!target) return

    // Claim the cooldown slot before sending, so a burst of messages sends one text.
    const claimed = await db.runTransaction(async (tx) => {
      const last = millis((await tx.get(matchRef)).data()?.lastMessageSmsAt)
      if (last !== null && Date.now() - last < MESSAGE_SMS_COOLDOWN_MS) return false
      tx.update(matchRef, { lastMessageSmsAt: FieldValue.serverTimestamp() })
      return true
    })
    if (!claimed) return

    const senderName = await nameFor(senderId, match.participantSnapshots)
    await sendSMS(target.phone, `💬 ${senderName} sent you a message on Zylove. zylove.app/matches`)
  },
)

// New match: texts each participant who has it on. A trigger on the match doc
// rather than inside likeBack, so matches from onLike (mobile and web
// Discover) and bots are covered too.
export const smsOnMatch = onDocumentCreated(
  { document: 'matches/{matchId}', secrets: SMS_SECRETS },
  async (event) => {
    const match = event.data?.data()
    const users = participantsOf(match)
    if (!match || users.length !== 2) return
    const play = match.mode === 'play'
    await Promise.all(
      users.map(async (uid) => {
        const target = await smsTarget(uid, 'newMatch', play ? 'play' : 'spark')
        if (!target) return
        const otherUid = users.find((u) => u !== uid) ?? ''
        const body = play
          ? "🔥 You're now entangled on Zylove Play. zylove.app/matches"
          : `✦ Sparks are flying. You and ${await nameFor(otherUid, match.participantSnapshots)} connected on Zylove. zylove.app/matches`
        await sendSMS(target.phone, body)
      }),
    )
  },
)

// Quiet chat nudge: conversations whose last message was 24–48h ago. Each
// match is nudged at most once per 48h. Runs at 9am, 3pm and 9pm Central so
// nobody gets a nudge in the middle of the night.
export const nudgeQuietChats = onSchedule(
  { schedule: '0 9,15,21 * * *', timeZone: 'America/Chicago', secrets: SMS_SECRETS, timeoutSeconds: 300 },
  async () => {
    const db = getFirestore()
    const now = Date.now()
    const quiet = await db
      .collection('matches')
      .where('lastMessageAt', '>=', Timestamp.fromMillis(now - 48 * HOUR_MS))
      .where('lastMessageAt', '<=', Timestamp.fromMillis(now - 24 * HOUR_MS))
      .get()

    let sent = 0
    for (const doc of quiet.docs) {
      const match = doc.data()
      if (match.isBlocked === true) continue
      const lastNudge = millis(match.lastNudgeSmsAt)
      if (lastNudge !== null && now - lastNudge < NUDGE_COOLDOWN_MS) continue
      const users = participantsOf(match)
      if (users.length !== 2) continue

      let nudged = false
      for (const uid of users) {
        // The chat's own mode decides which master switch applies.
        const target = await smsTarget(uid, 'quietNudge', match.mode === 'play' ? 'play' : 'spark')
        if (!target) continue
        const otherName = await nameFor(users.find((u) => u !== uid) ?? '', match.participantSnapshots)
        if (await sendSMS(target.phone, `☕ Your conversation with ${otherName} has been quiet. Need a spark? zylove.app/matches`)) {
          nudged = true
          sent++
        }
      }
      if (nudged) await doc.ref.update({ lastNudgeSmsAt: FieldValue.serverTimestamp() })
    }
    logger.info('nudgeQuietChats: done', { candidates: quiet.size, sent })
  },
)

// ─── validatePhoneNumber ─────────────────────────────────────────────────────

// Twilio Lookup v2 reports camelCase types; the other spellings are kept in
// case older/alternate values show up.
const BLOCKED_LINE_TYPES = new Set([
  'landline',
  'fixedVoip',
  'nonFixedVoip',
  'tollFree',
  'voip',
  'virtual',
  'toll-free',
  'non-fixed-voip',
])

const PHONE_ATTEMPT_LIMIT = 5
const PHONE_ATTEMPT_WINDOW_MS = 60 * 60 * 1000

// phoneVerificationAttempts/{sha256(phone)}: a fixed 1-hour window per
// number. Returns false once the number exceeds the limit. Server-only
// collection (client rules deny it). expiresAt lets a Firestore TTL policy
// clean up old windows.
async function underPhoneAttemptLimit(phoneNumber: string): Promise<boolean> {
  const db = getFirestore()
  const id = createHash('sha256').update(phoneNumber).digest('hex')
  const ref = db.collection('phoneVerificationAttempts').doc(id)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const now = Timestamp.now()
    const first: unknown = snap.get('firstAttempt')
    const windowOpen =
      snap.exists && first instanceof Timestamp && now.toMillis() - first.toMillis() < PHONE_ATTEMPT_WINDOW_MS
    if (!windowOpen) {
      tx.set(ref, {
        count: 1,
        firstAttempt: now,
        lastAttempt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(now.toMillis() + PHONE_ATTEMPT_WINDOW_MS),
      })
      return true
    }
    const count = (typeof snap.get('count') === 'number' ? (snap.get('count') as number) : 0) + 1
    tx.update(ref, { count: FieldValue.increment(1), lastAttempt: FieldValue.serverTimestamp() })
    return count <= PHONE_ATTEMPT_LIMIT
  })
}

// True when the number already belongs to a Firebase Auth account. Unknown
// on error, which counts as "not existing" so the Lookup still runs.
async function phoneHasAccount(phoneNumber: string): Promise<boolean> {
  try {
    await getAuth().getUserByPhoneNumber(phoneNumber)
    return true
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : null
    if (code !== 'auth/user-not-found') {
      logger.warn('validatePhoneNumber: account lookup failed', { message: err instanceof Error ? err.message : String(err) })
    }
    return false
  }
}

// Runs before the OTP is sent so VoIP / virtual / landline numbers can't sign
// up. Callable without auth (it gates sign-in). Order: rate limit first (it
// also stops this being used to probe which numbers have accounts), then
// existing accounts skip the paid Lookup, then the Lookup itself. Fails open
// on any Lookup or Firestore error.
export const validatePhoneNumber = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public', secrets: LOOKUP_SECRETS },
  async (request): Promise<{ allowed: boolean; reason?: string }> => {
    const data: unknown = request.data
    const phoneNumber =
      typeof data === 'object' && data !== null && 'phoneNumber' in data ? (data as { phoneNumber: unknown }).phoneNumber : null
    if (typeof phoneNumber !== 'string' || !/^\+[1-9]\d{6,14}$/.test(phoneNumber)) {
      throw new HttpsError('invalid-argument', 'phoneNumber must be E.164, e.g. +15551234567')
    }

    const underLimit = await underPhoneAttemptLimit(phoneNumber).catch((err: unknown) => {
      logger.warn('validatePhoneNumber: rate limit check failed', { message: err instanceof Error ? err.message : String(err) })
      return true
    })
    if (!underLimit) {
      logger.info('validatePhoneNumber: rate limited')
      return { allowed: false, reason: 'rate_limited' }
    }

    // Existing users are never locked out, and don't cost a Lookup.
    if (await phoneHasAccount(phoneNumber)) return { allowed: true }

    const lineType = await lookupLineType(phoneNumber)
    if (lineType !== null && BLOCKED_LINE_TYPES.has(lineType)) {
      logger.info('validatePhoneNumber: blocked', { lineType })
      return { allowed: false, reason: 'voip' }
    }
    return { allowed: true }
  },
)
