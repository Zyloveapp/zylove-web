// TODO: Admin dashboard — behavioral metadata, score trends, report patterns, match rates
// Data exists in: users/{uid}.behaviorSignals, users/{uid}.behaviorRiskScore,
// reviewQueue collection, config/launch, publicStats/founding
// Build as /admin route gated on isAdmin: true when Stripe is complete
// (Behavior signals and risk scores actually live server-only in behaviorSignals/{uid}; see behavior.ts.)
// Must stay the first import: global defaults (memory) before any function is defined.
import './globalOptions'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore'
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
import { loadReviewPhotos, photoConsent } from './reviewPhotos'
import {
  GO_DEEPER_FOCUS,
  buildPlayGoDeeperPrompt,
  cleanGoDeeperQuestion,
  parsePlayGoDeeperRequest,
} from './playGoDeeperPrompt'
import { SPARK_GO_DEEPER_FOCUS, buildSparkGoDeeperPrompt, parseSparkGoDeeperRequest } from './sparkGoDeeperPrompt'
import { LOOKUP_SECRETS, SMS_SECRETS, claimSparkSmsSlot, decideMessageSms, lookupLineType, nameFor, sendSMS, smsTarget } from './sms'

export { assignFounderBadge, onLaunchConfigUpdated } from './founders'
export { checkFounderActivity, founderHeartbeat } from './founderActivity'
export { ensureSortKey } from './discovery'
export { mirrorPlayOnlyPhotos } from './playPhotoMirror'
export { listPendingPhotos, reviewPendingPhoto } from './photoReview'
export { adminCityStats, adminListDeletions, adminPurgeAccount } from './adminTools'
export { adminGetActivity, adminUserAction } from './adminActivity'
export { deleteKeyBackup, getKeyBackupInfo, restoreKeyBackup, saveKeyBackup } from './keyBackup'
export { deleteModePhotos } from './profilePhotos'
export { deletePlayProfile, updateDisplayName } from './displayName'
export { processBotLikeBacks, queueBotLikeBack } from './botLikeBack'
import { scoreToTier, type ZyloveScoreTier } from './shared/zyloveScore'
import { keptForReport, recomputeBehaviorRisk, recordVibeSignal } from './behavior'
import { requireTier, tierNow } from './entitlements'
import { accountRef, internalRef, isAdminAuth, isDeletedUid, isSuspendedUid, loadInternal, loadMatching, loadSettings, requireActive } from './userData'
import { blockedEitherWay, likedInMode, likersInMode, pairIdOf } from './likes'
// §4.A3: likes are named to the liked person by an opaque like id.
import { isLikeId } from './likerPreviewCore'
import { listLikes, resolveLike } from './likerPreview'
import { performLike } from './legacy/onLike'
import { takeRateLimit } from './rateLimits'
import { logId } from './logSafe'
import { hasLinkOrNumber, safeBio, safeStarters } from './aiOutput'
import { AiBusy, AiCallFailed, startAiSpend, type AiSpend } from './aiCall'
import { buildPlayStarterPrompt, buildProfileQuestionPrompt, buildStarterPrompt, playPersonLine, profileForReview } from './profilePrompts'
import { loadSparkDetails } from './pairSpark'
import { clientIp, ipRateKey } from './clientIp'
import { isBotUid, playStatus, requirePlayAccess, requirePlayEntitled } from './playAccess'
import { loadPlayScores } from './pairPlay'
import { otherUidOf } from './playPairQueries'
import { markActed } from './explore'
import { countMessages, generationOf, participants, pastConnectionId } from './matchGeneration'
import { ensurePlayId, isPlayMatchId, requireUidOfPlayId } from './playIds'
import { createPlayMatch, livePlayMatchOf, loadMatch, matchRefOf, requireMatchWith } from './playMatch'
import { publicPlayProfile } from './playProfiles'
import {
  FLAG_CATEGORY_IDS,
  MAX_NEGATIVE_DELTA,
  MAX_POSITIVE_DELTA,
  MODERATION_RULES,
  POINTS_PER_NEGATIVE,
  POINTS_PER_POSITIVE,
  REVIEW_TONE,
} from './shared/reviewCategories'
import { updateSearchName } from './searchName'
import { ensureAccountDefaults, memberSinceOf } from './accountDefaults'

initializeApp()

const anthropicKey = defineSecret('ANTHROPIC_API_KEY')

// Same cap as both profile editors (mobile and web).
const MAX_BIO_LENGTH = 300

interface BioResponse {
  bio: string
  // The plan's allowance is used up (Stage C).
  limited?: boolean
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
    if (!(await requireActive(request.auth.uid).then(() => true, () => false))) return { bio: '' }
    // Stage B: was unlimited. Over the limit the app falls back to its own template.
    // Stage C: the plan's allowance (usage.ts). Used up: no AI call — the app
    // shows its own template and the upgrade note. C2: a call that was
    // answered counts, even if its bio is then dropped (aiCall.ts).
    let ai: AiSpend
    try {
      ai = await startAiSpend(request.auth.uid, 'sparkBio', anthropicKey.value())
    } catch (err) {
      return err instanceof AiBusy ? { bio: '' } : { bio: '', limited: true }
    }

    try {
      const input = parseBioRequest(request.data)
      const reply = await ai.ask({ label: 'generateSparkBio', prompt: buildBioPrompt(input), maxTokens: 400 })
      // F-095: a bio with a link, handle or number is dropped (aiOutput.ts).
      return { bio: safeBio(truncateAtWord(reply, MAX_BIO_LENGTH)) }
    } catch (err) {
      if (!(err instanceof AiCallFailed)) logger.error('generateSparkBio failed', { message: err instanceof Error ? err.message : String(err) })
      await ai.refundIfUnbilled()
      return { bio: '' }
    }
  },
)



// Writes a Play bio from Play onboarding answers. Unlike generateSparkBio this
// is rate limited (3 per rolling week), so hitting the limit is an error the
// client can show; any other failure returns an empty bio.
export const generatePlayBio = onCall(
  { timeoutSeconds: 120, memory: '256MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<BioResponse> => {
    // invoker is public (org policy), so gate spend on a signed-in caller.
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to generate a bio.')
    await requireActive(request.auth.uid)
    await requirePlayEntitled(request.auth.uid)
    // Stage B: the slot is reserved before the call (parallel calls can't
    // overrun the limit). C2: given back only if the call failed.
    const ai = await startAiSpend(request.auth.uid, 'playBio', anthropicKey.value())

    try {
      const input = parsePlayBioRequest(request.data)
      const reply = await ai.ask({ label: 'generatePlayBio', prompt: buildPlayBioPrompt(input), maxTokens: 300 })
      // F-095: a bio with a link, handle or number is dropped (aiOutput.ts).
      return { bio: safeBio(truncateAtWord(reply, MAX_BIO_LENGTH)) }
    } catch (err) {
      if (!(err instanceof AiCallFailed)) logger.error('generatePlayBio failed', { message: err instanceof Error ? err.message : String(err) })
      await ai.refundIfUnbilled()
      return { bio: '' }
    }
  },
)

// ─── generatePlayGoDeeper ─────────────────────────────────────────────────────

const GO_DEEPER_TEMPERATURES = [0.9, 1.0] as const


// One question from the shared prompt ('' when the reply has none). Throws
// AiCallFailed when the call failed.
async function askGoDeeper(ai: AiSpend, label: string, prompt: string, temperature: number): Promise<string> {
  const reply = await ai.ask({ label, prompt, maxTokens: 100, temperature })
  // F-095: a question naming a link, handle or number counts as no question
  // (Go Deeper questions can end up on the profile).
  const question = cleanGoDeeperQuestion(reply)
  return hasLinkOrNumber(question) ? '' : question
}

const sameQuestion = (a: string, b: string) => a.toLowerCase().replace(/\W/g, '') === b.toLowerCase().replace(/\W/g, '')

// Two personal Go Deeper questions written from the user's Play answers, one
// after the other: each call has its own focus, and the second is shown the
// first question so it picks a different angle. If they still match, the
// second is asked once more. Limited like generatePlayBio (the plan's
// allowance; a call that was answered counts).
export const generatePlayGoDeeper = onCall(
  { timeoutSeconds: 60, memory: '256MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<{ questions: [string, string] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to generate questions.')
    await requireActive(request.auth.uid)
    await requirePlayEntitled(request.auth.uid)
    const input = parsePlayGoDeeperRequest(request.data)
    // Reserved before the calls (Stage B). C2: given back only if no call
    // was answered — a pair dropped by the filters or the duplicate check
    // still counts.
    const ai = await startAiSpend(request.auth.uid, 'playGoDeeper', anthropicKey.value())
    const label = 'generatePlayGoDeeper'
    let first = ''
    let second = ''
    try {
      first = await askGoDeeper(ai, label, buildPlayGoDeeperPrompt(input, { focus: GO_DEEPER_FOCUS[0] }), GO_DEEPER_TEMPERATURES[0])
      if (first) {
        const secondPrompt = buildPlayGoDeeperPrompt(input, { focus: GO_DEEPER_FOCUS[1], previousQuestion: first })
        second = await askGoDeeper(ai, label, secondPrompt, GO_DEEPER_TEMPERATURES[1])
        if (second && sameQuestion(first, second)) second = await askGoDeeper(ai, label, secondPrompt, GO_DEEPER_TEMPERATURES[1])
      }
    } catch (err) {
      if (!(err instanceof AiCallFailed)) logger.error('generatePlayGoDeeper failed', { message: err instanceof Error ? err.message : String(err) })
    }
    if (!first || !second || sameQuestion(first, second)) {
      await ai.refundIfUnbilled()
      throw new HttpsError('unavailable', "Couldn't generate questions right now.")
    }
    return { questions: [first, second] }
  },
)

// ─── generateSparkGoDeeper ────────────────────────────────────────────────────



// Spark onboarding's Go Deeper: two personal questions from the user's Spark
// answers, same two-call shape as generatePlayGoDeeper (the second sees the
// first so it takes a different angle). The plan's allowance (usage.ts).
export const generateSparkGoDeeper = onCall(
  { timeoutSeconds: 60, memory: '256MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<{ questions: [string, string] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to generate questions.')
    await requireActive(request.auth.uid)
    const input = parseSparkGoDeeperRequest(request.data)
    // Reserved before the calls (Stage B); given back only if no call was
    // answered (C2, as generatePlayGoDeeper).
    const ai = await startAiSpend(request.auth.uid, 'sparkGoDeeper', anthropicKey.value())
    const label = 'generateSparkGoDeeper'
    let first = ''
    let second = ''
    try {
      first = await askGoDeeper(
        ai,
        label,
        buildSparkGoDeeperPrompt(input, { focus: SPARK_GO_DEEPER_FOCUS[0] }),
        GO_DEEPER_TEMPERATURES[0],
      )
      if (first) {
        const secondPrompt = buildSparkGoDeeperPrompt(input, { focus: SPARK_GO_DEEPER_FOCUS[1], previousQuestion: first })
        second = await askGoDeeper(ai, label, secondPrompt, GO_DEEPER_TEMPERATURES[1])
        if (second && sameQuestion(first, second)) second = await askGoDeeper(ai, label, secondPrompt, GO_DEEPER_TEMPERATURES[1])
      }
    } catch (err) {
      if (!(err instanceof AiCallFailed)) logger.error('generateSparkGoDeeper failed', { message: err instanceof Error ? err.message : String(err) })
    }
    if (!first || !second || sameQuestion(first, second)) {
      await ai.refundIfUnbilled()
      throw new HttpsError('unavailable', "Couldn't generate questions right now.")
    }
    return { questions: [first, second] }
  },
)

// Defaults for new profiles. Public ones stay on users/{uid}; the plan,
// trust counters and suspension live in userInternal (server-only;
// userData.ts — Stage 3 moved isSuspended there).
const PUBLIC_DEFAULTS = {
  verificationStatus: 'unverified',
} as const
const INTERNAL_DEFAULTS = {
  reportCount: 0,
  sparkScore: 50,
  isSuspended: false,
} as const

// "2026-10": the month an account was created (accountDefaults.ts).
export { memberSinceOf }

// Fills in whichever defaults are missing for the caller. Only missing fields
// are written, so values set elsewhere (e.g. Elite from a founder spot) are
// never overwritten. Idempotent. Also starts the 30-day trial (trial.ts) for
// anyone without one whose market has opened — existing users too, since the
// app calls this on every load. In a pre-launch market (or none) there's no
// clock yet. H1: the server does the trial and the account's age without
// this call too (accountDefaults.ts).

export const initUserDefaults = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    // F-097: nothing filled in (or a trial started) while suspended — the
    // app calls this on load and ignores a refusal; it runs again once the
    // account is active.
    await requireActive(uid)

    const ref = getFirestore().collection('users').doc(uid)
    const snap = await ref.get()
    // Never create a stub profile — onboarding must have saved the doc first.
    if (!snap.exists) throw new HttpsError('failed-precondition', 'Profile not found')

    const data = snap.data() ?? {}
    const internal = await loadInternal(uid, data)
    const missing: Record<string, unknown> = Object.fromEntries(
      Object.entries(PUBLIC_DEFAULTS).filter(([field]) => data[field] === undefined),
    )
    const missingInternal: Record<string, unknown> = Object.fromEntries(
      Object.entries(INTERNAL_DEFAULTS).filter(([field]) => internal[field] === undefined),
    )
    // Stage C: the stored tier is only ever what was bought; what someone
    // gets is the server's entitlement (entitlements.ts), which also covers
    // identity, founders, trials and pre-launch.
    if (internal.subscriptionTier === undefined) missingInternal.subscriptionTier = 'free'
    // Gender (and age) are locked once onboarding is done (rules then refuse
    // changes to them) — Elite comes from gender, so it can't be switched
    // later. Mobile locks at its onboarding step 2. §4.A2: the gender is in
    // private/matching (the public doc's old copy until migrated).
    const matchingNow = await loadMatching(uid, data)
    if (data.identityLockedAt == null && matchingNow.genderIdentity != null) {
      missing.identityLockedAt = FieldValue.serverTimestamp()
    }
    // The trial (once per phone number, never after a paid plan, only in a
    // launch city that's open) and the account's age (accountCreatedAt,
    // memberSince, newUntil): H1 — the server fills these in itself too
    // (accountDefaults.ts, from the entitlement triggers), so skipping this
    // call gains nothing. The verified number: from the token, else the Auth
    // record (sign-ins that don't carry it on the token).
    await ensureAccountDefaults(uid, typeof request.auth.token.phone_number === 'string' ? { phone: request.auth.token.phone_number } : {})
    // T&S Phase 1: the admin directory's name index.
    if (typeof data.displayName === 'string' && internal.searchName !== data.displayName.trim().toLowerCase()) {
      await updateSearchName(uid, data.displayName)
    }
    // Explore pool position (see discovery.ts): set once, never changed.
    if (typeof data.sortKey !== 'number') missing.sortKey = Math.random()
    // A location saved before the profile existed (setLocation) leaves its
    // city label in private/account; the public doc gets it now.
    if (typeof data.locationLabel !== 'string' || data.locationLabel === '') {
      const label: unknown = (await accountRef(uid).get()).data()?.location?.label
      if (typeof label === 'string' && label) missing.locationLabel = label
    }
    if (Object.keys(missing).length > 0) await ref.set(missing, { merge: true })
    if (Object.keys(missingInternal).length > 0) await internalRef(uid).set(missingInternal, { merge: true })
    if (Object.keys(missing).length + Object.keys(missingInternal).length > 0) {
      logger.info('initUserDefaults: filled missing fields', { fields: [...Object.keys(missing), ...Object.keys(missingInternal)] })
    }
    return { success: true }
  },
)

// ─── likeBack ────────────────────────────────────────────────────────────────

// §4.A3: the like is named by its opaque like id (getLikes) — the app never
// has the liker's uid or Play ID before the match.
interface LikeBackRequest {
  likeId: string
}

interface LikeBackResponse {
  matched: true
  matchId: string
  // Who they are, now that you're linked: their uid (Spark) or Play ID (Play).
  partnerId: string
}

function parseLikeBackRequest(data: unknown): LikeBackRequest {
  if (typeof data !== 'object' || data === null) throw new HttpsError('invalid-argument', 'Missing request data')
  const { likeId } = data as Record<string, unknown>
  if (!isLikeId(likeId)) throw new HttpsError('invalid-argument', 'likeId required')
  return { likeId }
}

function firstString(v: unknown): string | null {
  return Array.isArray(v) && typeof v[0] === 'string' && v[0] ? v[0] : null
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

// The name and photo someone shows in a mode. Spark: the root displayName
// and photoURLs[0]. Play (`play` = their playProfile/data, possibly empty):
// root playDisplayName, else the Play profile's own name, else 'Someone';
// never the Spark displayName or photo (mode sealing). Mirrors playNameOf in
// the web app's displayNames.ts.
function modeIdentity(
  user: DocumentData | undefined,
  play: DocumentData | null,
): { displayName: string; photoURL: string | null } {
  if (play) {
    return {
      displayName:
        nonEmpty(play.playDisplayName) ??
        nonEmpty(user?.playDisplayName) ??
        nonEmpty(play.displayName) ??
        'Someone',
      photoURL: firstString(play.photoURLs),
    }
  }
  return { displayName: nonEmpty(user?.displayName) ?? 'Someone', photoURL: firstString(user?.photoURLs) }
}

// Same snapshot shape the mobile app, botEngine and the web client write.
// Pass `play` (their playProfile/data, {} if none) for a Play match.
function participantSnapshot(
  user: DocumentData | undefined,
  play: DocumentData | null = null,
): {
  displayName: string
  age: number | null
  photoURL: string | null
} {
  return {
    ...modeIdentity(user, play),
    age: typeof user?.age === 'number' && user.age > 0 ? user.age : null,
  }
}

// someone's playProfile/data ({} when they have none or it can't be read).
async function playDataOf(uid: string): Promise<DocumentData> {
  const snap = await getFirestore().doc(`users/${uid}/playProfile/data`).get().catch(() => null)
  return snap?.data() ?? {}
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
    const req = parseLikeBackRequest(request.data)
    // §4.A3: the like id → the like, from the caller's own queue, server-side
    // (hidden likes — blocked, suspended, deleted — aren't found).
    const like = await resolveLike(callerId, req.likeId)
    const mode = like.mode
    if (mode === 'play') await requirePlayAccess(callerId)
    const likerUid = like.likerUid
    // Stage 2: a Play match needs Play access on both sides.
    if (mode === 'play' && !(await playStatus(likerUid)).access) throw new HttpsError('failed-precondition', "That profile isn't available in Play.")

    const db = getFirestore()
    const [callerPlayId, likerPlayId] = mode === 'play' ? await Promise.all([ensurePlayId(callerId), ensurePlayId(likerUid)]) : [null, null]
    const callerQueueRef = like.ref
    const likerQueueRef = db.doc(`users/${likerUid}/likeQueue/${callerPlayId ?? callerId}`)
    // Stage A: the entry is only a pointer — the like itself must be real and
    // in this mode (bots' likes are server-written queue entries), and
    // neither side gone, suspended or blocked.
    const bot = likerUid.startsWith('zbot-')
    if (!bot && !(await likedInMode(likerUid, callerId, mode))) {
      throw new HttpsError('not-found', "That like isn't available.")
    }
    // Stage C: liking back from "who liked you" is Spark+ — except a bot's
    // like (no paid feature ever involves a bot).
    if (!likerUid.startsWith('zbot-')) await requireTier(callerId, 'spark_plus', 'Liking back')
    if ((await isSuspendedUid(callerId)) || (!bot && (await isSuspendedUid(likerUid))) || (await blockedEitherWay(callerId, likerUid))) {
      throw new HttpsError('failed-precondition', "That profile isn't available.")
    }
    // §4.A3: the like back itself is an ordinary like (the app used to call
    // onLike with the uid first): recorded, scored, matched and notified by
    // the same code. A match it creates is found live below.
    await performLike(callerId, likerUid, mode)
    // The behaviour record recordSwipe kept for the app's like (best effort).
    await db.collection('swipes').add({ swiperId: callerId, swipedId: likerUid, action: 'like', mode, timestamp: Timestamp.now() }).catch(() => {})

    if (mode === 'play') {
      // F-062: a Play match — its own id, Play IDs only.
      const [callerSnap, likerSnap, callerPlay, likerPlay] = await Promise.all([
        db.doc(`users/${callerId}`).get(),
        db.doc(`users/${likerUid}`).get(),
        playDataOf(callerId),
        playDataOf(likerUid),
      ])
      if (!likerSnap.exists) throw new HttpsError('not-found', 'That profile no longer exists')
      const now = Timestamp.now()
      const snap = (uid: string, root: DocumentData | undefined, play: DocumentData, playId: string) => {
        const pub = publicPlayProfile(uid, playId, play, root)
        return { displayName: pub.playDisplayName || 'Someone', photoURL: pub.photoURLs?.[0] ?? null, age: pub.age ?? null }
      }
      const [matchId, created] = await createPlayMatch({
        users: [callerId, likerUid],
        pairId: pairIdOf(callerId, likerUid),
        fields: (ids) => ({
          matchedAt: now,
          createdAt: now,
          matchGeneration: now.toMillis(),
          lastMessagePreview: null,
          hasUnread: false,
          isBlocked: false,
          ...(isBotUid(likerUid) ? { isBot: true, botPlayer: ids.get(likerUid) } : {}),
          participantSnapshots: {
            [ids.get(callerId)!]: snap(callerId, callerSnap.data(), callerPlay, ids.get(callerId)!),
            [ids.get(likerUid)!]: snap(likerUid, likerSnap.data(), likerPlay, ids.get(likerUid)!),
          },
        }),
      })
      if (created) {
        await Promise.all([
          db.doc(`users/${callerId}/matches/${matchId}`).set({ matchId, otherPlayId: likerPlayId, createdAt: now, mode }),
          db.doc(`users/${likerUid}/matches/${matchId}`).set({ matchId, otherPlayId: callerPlayId, createdAt: now, mode }),
        ])
      }
      await Promise.all([markActed(callerId, mode, likerUid), markActed(likerUid, mode, callerId)])
      await callerQueueRef.delete()
      await likerQueueRef.delete().catch(() => {})
      logger.info(created ? 'likeBack: match created' : 'likeBack: match already existed', { mode })
      return { matched: true, matchId, partnerId: likerPlayId! }
    }

    const matchId = [callerId, likerUid].sort().join('_')
    const matchRef = db.collection('matches').doc(matchId)
    // onBotMessage only replies on matches flagged isBot (zbot- isn't in its
    // legacy seed- prefix check).
    const isBot = likerUid.startsWith('zbot-')

    // Transaction so two taps (or both people at once) create one match.
    const created = await db.runTransaction(async (tx) => {
      const existing = await tx.get(matchRef)
      const prior = existing.data()
      // A live match (performLike, just above, may have created it first,
      // without the bot flag) stays.
      if (existing.exists && prior?.unmatchedAt == null && prior?.isBlocked !== true) {
        if (isBot && prior?.isBot !== true) tx.update(matchRef, { isBot: true, botUid: likerUid })
        return false
      }
      // F-069: an ended chat kept for a report, or a blocked one, is never
      // replaced; one kept only by default gives way to the new match.
      if (existing.exists && (prior?.isBlocked === true || keptForReport(prior))) {
        throw new HttpsError('failed-precondition', "That profile isn't available.")
      }
      const [callerSnap, likerSnap] = await Promise.all([
        tx.get(db.collection('users').doc(callerId)),
        tx.get(db.collection('users').doc(likerUid)),
      ])
      if (!likerSnap.exists) throw new HttpsError('not-found', 'That profile no longer exists')
      // matchGeneration = matchedAt (see matchGeneration.ts).
      const now = Timestamp.now()
      tx.set(matchRef, {
        matchId,
        users: [callerId, likerUid].sort(),
        mode,
        matchedAt: now,
        createdAt: now,
        matchGeneration: now.toMillis(),
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

    // Explore (Stage 3): matched — neither shows the other again in this mode.
    await Promise.all([markActed(callerId, mode, likerUid), markActed(likerUid, mode, callerId)])

    // The like is consumed either way. The liker's entry for the caller may
    // not exist; delete() on a missing doc is a no-op, and a failure here
    // shouldn't undo a match that now exists.
    await callerQueueRef.delete()
    await likerQueueRef.delete().catch((err: unknown) =>
      logger.warn('likeBack: liker queue cleanup failed', { message: err instanceof Error ? err.message : String(err) }),
    )

    logger.info(created ? 'likeBack: match created' : 'likeBack: match already existed', { matchId: logId(matchId), mode })
    return { matched: true, matchId, partnerId: likerUid }
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
// `otherId`: how the partner is known in this match (Play ID in Play).
async function markMutualVibe(matchId: string, otherId: string): Promise<boolean> {
  const db = getFirestore()
  const ref = matchRefOf(matchId)
  return db.runTransaction(async (tx) => {
    const m = (await tx.get(ref)).data() ?? {}
    const theirs = m[`lastVibeRating_${otherId}`]
    const theirAt: unknown = m[`lastVibeRatedAt_${otherId}`]
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
    await requireActive(request.auth.uid)
    const callerId = request.auth.uid
    const matchId = requireString(request.data, 'matchId')
    const rating = (request.data as Record<string, unknown>).rating
    if (!VIBE_RATINGS.includes(rating as VibeRating)) {
      throw new HttpsError('invalid-argument', "rating must be 'loving_it', 'alright' or 'meh'")
    }
    const vibe = rating as VibeRating
    // F-062: otherUid is how the caller was shown the partner (a Play ID in Play).
    const { ctx, other: otherUid } = await requireMatchWith(matchId, callerId, requireString(request.data, 'otherUid'))
    const match = ctx.data
    const me = ctx.idOf(callerId)
    // 'entanglement' is an older name for Play.
    const cooldownMs = match.mode === 'play' || match.mode === 'entanglement' ? VIBE_COOLDOWN_MS.play : VIBE_COOLDOWN_MS.spark

    const db = getFirestore()
    // One per rater per match generation, so a re-match starts fresh.
    const generation = generationOf(match)
    const vibeRef = db.collection('vibeChecks').doc(`${matchId}_${generation}_${callerId}`)
    // The client cooldown lives in localStorage, so enforce it here too —
    // otherwise repeated calls could farm points for a friend. Admins skip it
    // for testing, but a repeat inside the window moves no scores: the
    // rating is recorded, the points and behaviour signal aren't.
    const previous = await vibeRef.get()
    const previousAt: unknown = previous.data()?.createdAt
    const inCooldown = previousAt instanceof Timestamp && Date.now() - previousAt.toMillis() < cooldownMs
    const adminRepeat = inCooldown && isAdminAuth(request.auth)
    if (inCooldown && !adminRepeat) {
      throw new HttpsError('resource-exhausted', `Already rated this conversation in the last ${cooldownMs / 3_600_000} hours`)
    }

    // update() rather than set(merge) on users/* so a deleted profile fails
    // the batch instead of being recreated as a stub doc.
    const batch = db.batch()
    batch.set(vibeRef, { matchId, generation, raterUid: callerId, rating: vibe, createdAt: FieldValue.serverTimestamp() })
    batch.update(ctx.ref, {
      [`lastVibeRating_${me}`]: vibe,
      [`lastVibeRatedAt_${me}`]: FieldValue.serverTimestamp(),
      // The web client's vibe-check state (its cooldown reads this).
      [`vibeCheckState_${me}.lastRatedAt`]: FieldValue.serverTimestamp(),
      ...(vibe === 'loving_it' ? { warmSignal: true } : {}),
    })
    // F-096: nothing is written for a partner whose account was deleted
    // (their server records went with it).
    const partnerGone = await isDeletedUid(otherUid)
    const points = adminRepeat || partnerGone ? 0 : VIBE_POINTS[vibe]
    if (points !== 0) {
      batch.set(internalRef(otherUid), { zyloveScore: { vibePoints: FieldValue.increment(points) } }, { merge: true })
    }
    if (!adminRepeat) {
      batch.set(internalRef(callerId), { zyloveScore: { participationPoints: FieldValue.increment(1) } }, { merge: true })
    }
    await batch.commit()
    if (adminRepeat) logger.info('recordVibeRating: admin test repeat, no score change', { matchId: logId(matchId) })
    if (!adminRepeat && !partnerGone && !BOT_PREFIXES.some((p) => otherUid.startsWith(p))) {
      await recordVibeSignal(otherUid, vibe === 'loving_it').catch((err: unknown) =>
        logger.error('recordVibeRating: vibe signal failed', { matchId: logId(matchId), message: err instanceof Error ? err.message : String(err) }),
      )
    }

    const mutual =
      vibe === 'loving_it' &&
      (await markMutualVibe(matchId, ctx.idOf(otherUid)).catch((err: unknown) => {
        logger.error('recordVibeRating: mutual check failed', { matchId: logId(matchId), message: err instanceof Error ? err.message : String(err) })
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

    logger.info('recordVibeRating', { matchId: logId(matchId), rating: vibe, mutual })
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
    // F-097: a suspended account can't make itself visible again. Hiding or
    // pausing stays open to it (it only ever hides them — and "hide instead"
    // runs while a deletion is pending).
    if (visibility === 'active') await requireActive(uid)

    const db = getFirestore()
    const userRef = db.collection('users').doc(uid)
    if (!(await userRef.get()).exists) throw new HttpsError('failed-precondition', 'Profile not found')

    const field = `${mode}Visibility`
    // Play visibility lives on the Play profile (Stage 2: no Play data on the
    // public doc), Spark visibility on the root doc.
    const playRef = userRef.collection('playProfile').doc('data')
    if (mode === 'play' && !(await playRef.get()).exists) throw new HttpsError('failed-precondition', 'No Play profile')
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
    if (mode === 'play') {
      batch.update(playRef, { playVisibility: visibility })
      batch.update(userRef, { playVisibility: FieldValue.delete() })
    } else {
      batch.update(userRef, { [field]: visibility })
    }
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
    const [userSnap, scoreSnap, signalsSnap, internalSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(scoreRef),
      tx.get(signalsRef),
      tx.get(internalRef(uid)),
    ])
    if (!userSnap.exists) return
    const current = scoreSnap.data() ?? {}
    const internal = internalSnap.data()
    // userInternal holds the points; an unmigrated account still has them on the root.
    const points = internal?.zyloveScore || internal?.zylovScore ? vibePointsOf(internal) : vibePointsOf(userSnap.data())
    const adjustment = vibeAdjustment(signalsSnap.data(), points)
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

interface ReviewTarget {
  ended: boolean
  generation: number
  // Messages in that generation — the "had a conversation" check.
  messageCount: number
}

// Which match generation a review is for, and whether both people were in
// it. The live match doc when its generation is the one asked about (or
// none was asked); otherwise the pastConnections record behavior.ts writes
// when a match ends, which keeps the message count after the messages are
// purged. requested: the generation the client is reviewing, if it sent one
// (older clients and pre-generation matches don't).
async function resolveReviewTarget(
  matchId: string,
  callerId: string,
  otherUid: string,
  requested: number | null,
): Promise<ReviewTarget> {
  if (otherUid === callerId) throw new HttpsError('invalid-argument', 'reviewedUid must be your match')
  const db = getFirestore()
  const notParticipant = () => new HttpsError('permission-denied', 'Not a participant in this match')
  const requireBoth = (data: DocumentData | undefined) => {
    const users = participants(data)
    if (!users.includes(callerId) || !users.includes(otherUid)) throw notParticipant()
  }

  // F-062: a Play match's people are in its server-only record.
  const ctx = await loadMatch(matchId)
  const live = ctx?.data
  // F-078: only while the caller still has the chat — someone who left a
  // chat kept read-only for the other person reviews it from its
  // pastConnections record (below), as for any ended generation.
  if (ctx && live && ctx.has(callerId)) {
    if (!ctx.pair.includes(otherUid)) throw notParticipant()
    const generation = generationOf(live)
    if (requested === null || requested === generation) {
      return { ended: matchEnded(live), generation, messageCount: (await countMessages(matchId, generation)).total }
    }
  }

  // An ended generation: its record, by the generation asked for, else the
  // newest one for this match, else a record from before generations.
  const past = db.collection('pastConnections')
  let record: DocumentData | undefined
  if (requested !== null) record = (await past.doc(pastConnectionId(matchId, requested)).get()).data()
  else {
    const all = (await past.where('matchId', '==', matchId).get()).docs.map((d) => d.data())
    record = all.sort((a, b) => num(b.generation, 0) - num(a.generation, 0))[0] ?? (await past.doc(matchId).get()).data()
  }
  if (record) {
    requireBoth(record)
    const generation = num(record.generation, 0)
    const messageCount =
      typeof record.messageCount === 'number' ? record.messageCount : (await countMessages(matchId, generation)).total
    return { ended: true, generation, messageCount }
  }

  // Ended before past connections were kept: only the id vouches for the
  // pair, and messages (which only participants can write) for the match.
  if (live || matchId !== [callerId, otherUid].sort().join('_')) throw notParticipant()
  return { ended: true, generation: 0, messageCount: (await countMessages(matchId, 0)).total }
}

// Queues the reviewed user for the safety team once a category crosses its
// threshold. One reviewQueue doc per user and category (admin-only), never a
// field on the public users doc.
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

// One anonymous review per reviewer per match generation.
export const submitReview = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true; newScore: number; newTier: ZyloveScoreTier }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    await requireActive(request.auth.uid)
    const callerId = request.auth.uid
    const matchId = requireString(request.data, 'matchId')
    // F-062: in a Play match the reviewed person is named by their Play ID.
    const reviewedArg = requireString(request.data, 'reviewedUid')
    const reviewedUid = isPlayMatchId(matchId) ? await requireUidOfPlayId(reviewedArg, callerId) : reviewedArg
    const categories = parseCategories(request.data)
    if (BOT_PREFIXES.some((p) => reviewedUid.startsWith(p))) throw new HttpsError('invalid-argument', 'Bots cannot be reviewed')
    const requested: unknown = (request.data as Record<string, unknown> | null)?.generation
    const { ended, generation, messageCount } = await resolveReviewTarget(
      matchId,
      callerId,
      reviewedUid,
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? requested : null,
    )

    const db = getFirestore()
    if (messageCount < 1) throw new HttpsError('failed-precondition', 'Have a conversation before leaving a review')

    const positive = categories.filter((c) => REVIEW_TONE.get(c) === 'positive')
    const neutral = categories.filter((c) => REVIEW_TONE.get(c) === 'neutral')
    const negative = categories.filter((c) => REVIEW_TONE.get(c) === 'negative')
    const applyNegativeNow = negative.length > 0 && ended
    // A review whose only score impact is still pending stays invisible
    // (not even counted) until the match ends.
    const countedNow = negative.length === 0 || ended || positive.length > 0

    // One per reviewer per match generation. Reviews written before
    // generations were keyed {matchId}_{uid}; one of those made during this
    // generation still counts as this generation's review.
    const reviewRef = db.collection('reviews').doc(`${matchId}_${generation}_${callerId}`)
    const legacyReviewRef = db.collection('reviews').doc(`${matchId}_${callerId}`)
    const userRef = db.collection('users').doc(reviewedUid)
    const scoreRef = userRef.collection('zyloveScore').doc('current')

    const result = await db.runTransaction(async (tx) => {
      const [existing, legacy, scoreSnap, userSnap] = await Promise.all([
        tx.get(reviewRef),
        tx.get(legacyReviewRef),
        tx.get(scoreRef),
        tx.get(userRef),
      ])
      const legacyAt: unknown = legacy.data()?.createdAt
      const legacyThisGeneration = legacy.exists && (!(legacyAt instanceof Timestamp) || legacyAt.toMillis() >= generation)
      if (existing.exists || legacyThisGeneration) throw new HttpsError('already-exists', 'You already reviewed this connection')
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
        generation,
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
        matchId: logId(matchId),
        message: err instanceof Error ? err.message : String(err),
      }),
    )

    // Safety reports re-score behavior risk now rather than at the 2am run.
    if (categories.some((c) => c === 'felt_unsafe' || c === 'aggressive')) {
      await recomputeBehaviorRisk(reviewedUid).catch((err: unknown) =>
        logger.error('submitReview: behavior risk recompute failed', {
          matchId: logId(matchId),
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }

    logger.info('submitReview', { matchId: logId(matchId), positive: positive.length, neutral: neutral.length, negative: negative.length, ended })
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
async function applyHeldReviewsOnEnd(matchId: string, before: DocumentData | undefined, after: DocumentData | undefined): Promise<void> {
    if (!before) return
    // Deletion always counts, and so does a re-match overwriting the doc
    // (a new generation); applyPendingNegative skips anything already applied.
    const generation = generationOf(before)
    const replaced = after !== undefined && generationOf(after) !== generation
    const endedNow = after === undefined || replaced || (matchEnded(after) && !matchEnded(before))
    if (!endedNow) return

    const reviews = await getFirestore().collection('reviews').where('matchId', '==', matchId).get()
    // The ended generation's reviews (pre-generation ones carry none).
    const pending = reviews.docs.filter((d) => {
      const r = d.data()
      return r.negativePending === true && (typeof r.generation !== 'number' || r.generation === generation)
    })
    for (const d of pending) await applyPendingNegative(d.ref)
    if (pending.length > 0) logger.info('processMatchEnd: applied held negative reviews', { matchId: logId(matchId), count: pending.length })
}

export const processMatchEnd = onDocumentWritten({ document: 'matches/{matchId}', timeoutSeconds: 60, memory: '256MiB' }, async (event) =>
  applyHeldReviewsOnEnd(event.params.matchId, event.data?.before.data(), event.data?.after.data()),
)
// F-062: Play matches (playMatches/{pm_…}) end the same way.
export const processPlayMatchEnd = onDocumentWritten({ document: 'playMatches/{matchId}', timeoutSeconds: 60, memory: '256MiB' }, async (event) =>
  applyHeldReviewsOnEnd(event.params.matchId, event.data?.before.data(), event.data?.after.data()),
)

// ─── generateConversationStarter ─────────────────────────────────────────────

const FALLBACK_STARTERS = [
  'What made you swipe right?',
  'What are you looking forward to this week?',
  "What's your go-to first date spot in Austin?",
]

// Play matches: openers from the Play profiles only (playProfile/data and
// the Play name), never Spark data — the two modes stay sealed.
const PLAY_FALLBACK_STARTERS = [
  "What's the vibe you're hoping for?",
  'What caught your eye on my profile?',
  "What's your idea of a good first meet?",
]

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
  async (request): Promise<{ starters: string[]; limited?: boolean }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    await requireActive(request.auth.uid)
    const callerId = request.auth.uid
    const matchId = requireString(request.data, 'matchId')
    // Gates AI spend and profile reads to the caller's own match. F-062:
    // otherUid is how the caller was shown the partner (a Play ID in Play).
    const { ctx, other: otherUid } = await requireMatchWith(matchId, callerId, requireString(request.data, 'otherUid'))
    const play = ctx.play || ctx.data.mode === 'play'
    // Stage 2: a Play match is sealed while the caller has no Play access.
    if (play) await requirePlayAccess(callerId)
    const fallback = play ? PLAY_FALLBACK_STARTERS : FALLBACK_STARTERS
    // Stage C: Break the ice (from a profile) is Spark+; the in-chat nudge is
    // for everyone — both from the plan's starters allowance (Free: 1 a week,
    // Spark+/Elite: 5 a day). Used up: stock starters, no AI call.
    const source = (request.data as Record<string, unknown> | null)?.source === 'icebreaker' ? 'icebreaker' : 'nudge'
    if (source === 'icebreaker' && !otherUid.startsWith('zbot-')) await requireTier(callerId, 'spark_plus', 'Break the ice')
    // C2: a call that was answered counts, whatever its openers (aiCall.ts).
    let ai: AiSpend
    try {
      ai = await startAiSpend(callerId, 'starters', anthropicKey.value())
    } catch (err) {
      return err instanceof AiBusy ? { starters: fallback } : { starters: fallback, limited: true }
    }

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
      const reply = await ai.ask({ label: 'generateConversationStarter', prompt, maxTokens: 300 })
      // F-095: openers naming a link, handle, number or another app are dropped.
      return { starters: safeStarters(parseStarters(reply), fallback) }
    } catch (err) {
      if (!(err instanceof AiCallFailed)) logger.error('generateConversationStarter failed', { play, message: err instanceof Error ? err.message : String(err) })
      await ai.refundIfUnbilled()
      return { starters: fallback }
    }
  },
)

// ─── Profile AI: shared helpers ──────────────────────────────────────────────

async function loadOwnProfileDocs(uid: string): Promise<{ root: DocumentData; spark: DocumentData }> {
  const db = getFirestore()
  const [root, spark] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.doc(`users/${uid}/sparkProfile/data`).get(),
  ])
  if (!root.exists) throw new HttpsError('failed-precondition', 'Profile not found')
  return { root: root.data() ?? {}, spark: spark.data() ?? {} }
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
    await requireActive(request.auth.uid)
    const uid = request.auth.uid
    let fallback = DEFAULT_QUESTION
    // Stage C: 3 a day for everyone. Over the limit: the stock question, no AI call.
    // C2: a call that was answered counts, whatever its question (aiCall.ts).
    let ai: AiSpend
    try {
      ai = await startAiSpend(uid, 'profileQuestion', anthropicKey.value())
    } catch {
      return { question: fallback }
    }
    try {
      const { root, spark } = await loadOwnProfileDocs(uid)
      fallback = QUESTION_FALLBACKS[strings(root.personalityTraits)[0] ?? ''] ?? DEFAULT_QUESTION
      const prompt = buildProfileQuestionPrompt(root, spark)
      return { question: cleanQuestion(await ai.ask({ label: 'generateProfileQuestion', prompt, maxTokens: 100 })) ?? fallback }
    } catch (err) {
      if (!(err instanceof AiCallFailed)) logger.error('generateProfileQuestion failed', { message: err instanceof Error ? err.message : String(err) })
      await ai.refundIfUnbilled()
      return { question: fallback }
    }
  },
)

// ─── reviewProfile ───────────────────────────────────────────────────────────

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
    await requireActive(request.auth.uid)
    // Stage B: was unlimited. Reserved before the call. C2: given back only
    // if the call failed — an answered call counts even when its scorecard
    // doesn't parse.
    const ai = await startAiSpend(request.auth.uid, 'sparkReview', anthropicKey.value())
    let review: ProfileScorecard | null = null
    try {
      const { root, spark } = await loadOwnProfileDocs(request.auth.uid)
      const photos = photoConsent(await loadSettings(request.auth.uid, root), 'spark') ? await loadReviewPhotos(request.auth.uid, root.photoURLs) : []
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
      const reply = await ai.ask({ label: 'reviewProfile', prompt, images: photos, maxTokens, timeoutMs: 100_000 })
      review = parseScorecard(reply, SPARK_REVIEW_SECTIONS, { photos: photos.length > 0 })
      if (!review) logger.error('reviewProfile: reply was not a valid scorecard', { length: reply.length })
    } catch (err) {
      if (!(err instanceof AiCallFailed)) logger.error('reviewProfile failed', { message: err instanceof Error ? err.message : String(err) })
    }
    if (!review) {
      await ai.refundIfUnbilled()
      throw new HttpsError('unavailable', "Couldn't generate review. Try again.")
    }
    await saveReviewHistory(request.auth.uid, 'spark', review)
    return { review }
  },
)

// ─── reviewPlayProfile ───────────────────────────────────────────────────────


// "How's my Play profile? 🔥" — a scorecard for the caller's saved Play
// profile, with photo coaching when they opted in (photoAnalysisConsent.play).
// 3 per rolling week; only successful reviews count.
export const reviewPlayProfile = onCall(
  { timeoutSeconds: 120, memory: '512MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<{ review: ProfileScorecard }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    await requireActive(request.auth.uid)
    await requirePlayEntitled(request.auth.uid)
    const db = getFirestore()
    const [playSnap, settings] = await Promise.all([
      db.doc(`users/${request.auth.uid}/playProfile/data`).get(),
      loadSettings(request.auth.uid),
    ])
    if (!playSnap.exists) throw new HttpsError('failed-precondition', 'Set up your Play profile first.')
    // Reserved before the call (Stage B); given back only if the call failed (C2).
    const ai = await startAiSpend(request.auth.uid, 'playReview', anthropicKey.value())

    const play = playSnap.data() ?? {}
    let review: ProfileScorecard | null = null
    try {
      const photos = photoConsent(settings, 'play') ? await loadReviewPhotos(request.auth.uid, play.photoURLs) : []
      const reply = await ai.ask({
        label: 'reviewPlayProfile',
        prompt: buildPlayReviewPrompt(play, photos.length),
        images: photos,
        maxTokens: photos.length > 0 ? REVIEW_WITH_PHOTOS_MAX_TOKENS : REVIEW_MAX_TOKENS,
        timeoutMs: 100_000,
      })
      review = parseScorecard(reply, PLAY_REVIEW_SECTIONS, { photos: photos.length > 0 })
      if (!review) logger.error('reviewPlayProfile: reply was not a valid scorecard', { length: reply.length })
    } catch (err) {
      if (!(err instanceof AiCallFailed)) {
        await ai.refundIfUnbilled()
        throw err
      }
    }
    // C2: an answered call counts even when its scorecard doesn't parse.
    if (!review) {
      await ai.refundIfUnbilled()
      throw new HttpsError('unavailable', "Couldn't generate review. Try again.")
    }
    await saveReviewHistory(request.auth.uid, 'play', review)
    return { review }
  },
)

// ─── getSentSparks ───────────────────────────────────────────────────────────

// F-062: a Play entry is named by its Play ID (no uid).
interface SentSpark {
  uid?: string
  playId?: string
  displayName: string
  age: number | null
  photoURL: string | null
  sparkScore: number | null
  // Engine v2: false → "Not enough info"; with engineVersion, so the app
  // can tell an engine v1 score (null) from a v2 one.
  sparkEnoughInfo: boolean | null
  engineVersion: number | null
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
    await requireActive(request.auth.uid)
    // Stage C: the Sent tab is part of "who liked you" — Spark+.
    const callerTier = await requireTier(request.auth.uid, 'spark_plus', 'Sent likes')
    const uid = request.auth.uid
    const mode = (request.data as Record<string, unknown> | null)?.mode === 'play' ? 'play' : 'spark'
    if (mode === 'play') await requirePlayAccess(uid)
    const db = getFirestore()

    if (mode === 'play') return { sent: await sentPlayLikes(uid) }

    // Stage B: likes per mode (pairs/{id}/likes/{mode}, server-only) — the
    // pair doc no longer says who liked whom (its participants could read it).
    const myLikes = (await db.collectionGroup('likes').where('likedBy', 'array-contains', uid).get()).docs.filter(
      (d) => d.id === mode && d.ref.parent.parent?.parent.id === 'pairs',
    )
    const pairSnaps = myLikes.length ? await db.getAll(...myLikes.map((d) => d.ref.parent.parent!)) : []
    const unanswered = pairSnaps
      .filter((p, i) => {
        const other = p.get('userA') === uid ? p.get('userB') : p.get('userA')
        // Real people only (no paid feature involves a bot).
        if (typeof other === 'string' && other.startsWith('zbot-')) return false
        const likedBy: unknown = myLikes[i].get('likedBy')
        return p.exists && typeof other === 'string' && !(Array.isArray(likedBy) && likedBy.includes(other))
      })
      .slice(0, SENT_LIMIT)

    const sent = await Promise.all(
      unanswered.map(async (pairSnap): Promise<SentSpark | null> => {
        const pair = pairSnap.data() ?? {}
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
        if (!user || (await isSuspendedUid(otherUid, user))) return null
        const queue = queueSnap.data()
        if (queue && (queue.mode === 'play' ? 'play' : 'spark') !== mode) return null
        return {
          uid: otherUid,
          ...modeIdentity(user, null),
          age: typeof user.age === 'number' && user.age > 0 ? user.age : null,
          sparkScore: typeof pair.sparkScore === 'number' ? pair.sparkScore : null,
          sparkEnoughInfo: typeof pair.sparkEnoughInfo === 'boolean' ? pair.sparkEnoughInfo : null,
          engineVersion: typeof pair.engineVersion === 'number' ? pair.engineVersion : null,
          playScore: null,
          // Deep Fit is Elite (Stage C); its home is pairs/{id}/modes/deep.
          tier1Spark: callerTier === 'elite' ? (await loadSparkDetails(pairSnap.id, uid, pair)).tier1Spark : null,
          likedAt: toMillis(queue?.likedAt) || toMillis(pair.createdAt),
        }
      }),
    )

    return { sent: sent.filter((s): s is SentSpark => s !== null).sort((a, b) => b.likedAt - a.likedAt) }
  },
)

// F-065: the caller's unanswered Play likes, from playPairData (keyed by
// Play IDs) — Play likes no longer live under the uid pair.
async function sentPlayLikes(uid: string): Promise<SentSpark[]> {
  const snap = await getFirestore().collection('playPairData').where('likedBy', 'array-contains', uid).get()
  const pending = snap.docs
    .map((d) => ({ data: d.data(), other: otherUidOf(d.data(), uid) }))
    .filter((x): x is { data: DocumentData; other: string } => !!x.other && !x.other.startsWith('zbot-') && !(x.data.likedBy as string[]).includes(x.other))
    .slice(0, SENT_LIMIT)
  const sent = await Promise.all(pending.map(({ other, data }) => sentPlay(uid, other, data)))
  return sent.filter((s): s is SentSpark => s !== null).sort((a, b) => b.likedAt - a.likedAt)
}

// F-062: a sent Play like — the Play ID, Play name and photo, Play score.
async function sentPlay(uid: string, otherUid: string, pair: DocumentData): Promise<SentSpark | null> {
  const db = getFirestore()
  const [myPlayId, otherPlayId] = await Promise.all([ensurePlayId(uid), ensurePlayId(otherUid)])
  const [live, userSnap, queueSnap, play] = await Promise.all([
    livePlayMatchOf(uid, otherUid),
    db.collection('users').doc(otherUid).get(),
    db.doc(`users/${otherUid}/likeQueue/${myPlayId}`).get(),
    playDataOf(otherUid),
  ])
  const user = userSnap.data()
  if (live || !user || (await isSuspendedUid(otherUid, user))) return null
  if (!(await playStatus(otherUid)).access) return null
  const pub = publicPlayProfile(otherUid, otherPlayId, play, user)
  const playScores = await loadPlayScores(uid, otherUid)
  return {
    playId: otherPlayId,
    displayName: pub.playDisplayName || 'Someone',
    photoURL: pub.photoURLs?.[0] ?? null,
    age: pub.age ?? null,
    sparkScore: null,
    sparkEnoughInfo: null,
    engineVersion: typeof playScores?.engineVersion === 'number' ? playScores.engineVersion : null,
    playScore: typeof playScores?.playScore === 'number' ? playScores.playScore : null,
    tier1Spark: null,
    likedAt: toMillis(queueSnap.get('likedAt')) || toMillis(pair.scoredAt),
  }
}

// ─── getCuriousVisitors ──────────────────────────────────────────────────────

// F-062: a Play visitor is named by their Play ID (no uid, no Spark details).
interface CuriousVisitor {
  uid?: string
  playId?: string
  displayName: string
  age: number | null
  photoURL: string | null
  locationLabel: string | null
  intent: string | null
  sparkScore: number | null
  sparkEnoughInfo: boolean | null // as SentSpark
  engineVersion: number | null
  playScore: number | null
  tier1Spark: unknown
  at: number
}

const CURIOUS_LIMIT = 20


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
// them here would unmask them). Elite (the server entitlement) gets the
// list; everyone else gets only the count, enforced here so the list can't
// be fetched directly. With { mode }, only visitors who looked in that mode,
// shown as they are in it (Play name and photo in Play); without one (older
// clients), every visitor with their root profile, as before.
export const getCuriousVisitors = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ locked: boolean; count: number; visitors: CuriousVisitor[] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    await requireActive(request.auth.uid)
    const uid = request.auth.uid
    // F-064: one mode always (Spark unless asked) — with none, Play reveals
    // were listed under the Spark profile.
    const mode = (request.data as Record<string, unknown> | null)?.mode === 'play' ? 'play' : 'spark'
    // Stage 2: Play visitors only for callers with Play access.
    if (mode === 'play' && !(await playStatus(uid)).access) return { locked: true, count: 0, visitors: [] }
    const db = getFirestore()
    if (mode === 'play') {
      const visitors = await curiousPlay(uid)
      return (await tierNow(uid)) === 'elite'
        ? { locked: false, count: visitors.length, visitors }
        : { locked: true, count: visitors.length, visitors: [] }
    }

    const [asA, asB] = await Promise.all([
      db.collection('pairs').where('userA', '==', uid).get(),
      db.collection('pairs').where('userB', '==', uid).get(),
    ])
    // Stage C: the server's entitlement decides (Curious is Elite).
    const unlocked = (await tierNow(uid)) === 'elite'

    const revealed = [...asA.docs, ...asB.docs]
      .map((d) => ({ id: d.id, pair: d.data() }))
      .filter(({ pair }) => {
        const iAmA = pair.userA === uid
        const otherUid = iAmA ? pair.userB : pair.userA
        // Only a reveal recorded as Spark (older ones with no mode may be Play's).
        if (typeof otherUid !== 'string' || pair[`${otherUid}_revealed_spark`] !== true) return false
        if (pair.matched === true) return false
        // Neither side has liked: I haven't, and they haven't (Sparks covers that).
        return pair.userALiked !== true && pair.userBLiked !== true
      })
    // Spark likes rule them out (Stage B). F-065: never Play's — a Spark
    // list that changed with a Play like would link the two.
    const likeSnaps = revealed.length ? await db.getAll(...revealed.map(({ id }) => db.doc(`pairs/${id}/likes/spark`))) : []
    const liked = (i: number) => (likeSnaps[i]?.get('likedBy') ?? []).length > 0
    const candidates = revealed.filter((_, i) => !liked(i)).sort((a, b) => revealedAt(b.pair, uid) - revealedAt(a.pair, uid))

    const visitors: CuriousVisitor[] = []
    for (const { id, pair } of candidates) {
      if (visitors.length >= CURIOUS_LIMIT) break
      const otherUid: string = pair.userA === uid ? pair.userB : pair.userA
      if (otherUid.startsWith('zbot-')) continue // real people only
      const [matchSnap, userSnap] = await Promise.all([db.collection('matches').doc(id).get(), db.collection('users').doc(otherUid).get()])
      const user = userSnap.data()
      if (matchSnap.exists || !user || (await isSuspendedUid(otherUid, user)) || (await blockedEitherWay(uid, otherUid))) continue
      // Spark visitors need a Spark profile (Play-only accounts have Spark hidden).
      if (user.sparkVisibility === 'hidden') continue
      visitors.push({
        uid: otherUid,
        ...modeIdentity(user, null),
        age: typeof user.age === 'number' && user.age > 0 ? user.age : null,
        locationLabel: typeof user.locationLabel === 'string' && user.locationLabel ? user.locationLabel : null,
        intent: mode,
        sparkScore: typeof pair.sparkScore === 'number' ? pair.sparkScore : null,
        sparkEnoughInfo: typeof pair.sparkEnoughInfo === 'boolean' ? pair.sparkEnoughInfo : null,
        engineVersion: typeof pair.engineVersion === 'number' ? pair.engineVersion : null,
        playScore: null,
        tier1Spark: (await loadSparkDetails(id, uid, pair)).tier1Spark, // Curious is Elite: Deep Fit included
        at: revealedAt(pair, uid),
      })
    }

    return unlocked
      ? { locked: false, count: visitors.length, visitors }
      : { locked: true, count: visitors.length, visitors: [] }
  },
)

// F-062: Play reveals are recorded here, server-side, in
// playReveals/{viewedUid}/by/{viewerUid}. F-080: not while suspended, never
// between people who've blocked each other (quietly — no answer either way),
// and rate-limited.
export const recordPlayReveal = onCall({ timeoutSeconds: 15, invoker: 'public' }, async (request): Promise<{ ok: true }> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  await requireActive(uid)
  await requirePlayAccess(uid)
  const target = await requireUidOfPlayId((request.data as Record<string, unknown> | null)?.playId, uid)
  await takeRateLimit(uid, 'reveal', REVEAL_LIMIT)
  if (await blockedEitherWay(uid, target)) return { ok: true }
  await getFirestore().doc(`playReveals/${target}/by/${uid}`).set({ at: Date.now(), viewer: uid })
  return { ok: true }
})

const REVEAL_LIMIT = { max: 300, windowMs: 60 * 60 * 1000 }

// A Spark reveal (the viewer saw the score; feeds the other person's Curious
// tab). F-065: recorded server-side — pairs/{id} is server-only now, since a
// client read or update of it said whether the pair existed. Only on an
// existing pair, and the answer is the same either way.
export const recordSparkReveal = onCall({ timeoutSeconds: 15, invoker: 'public' }, async (request): Promise<{ ok: true }> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  await requireActive(uid)
  const target = (request.data as Record<string, unknown> | null)?.uid
  if (typeof target !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(target) || target === uid) throw new HttpsError('invalid-argument', 'uid required')
  await takeRateLimit(uid, 'reveal', REVEAL_LIMIT)
  if (await blockedEitherWay(uid, target)) return { ok: true }
  await getFirestore()
    .doc(`pairs/${pairIdOf(uid, target)}`)
    .update({ [`${uid}_revealed`]: true, [`${uid}_revealedAt`]: FieldValue.serverTimestamp(), [`${uid}_revealed_spark`]: true })
    .catch(() => {})
  return { ok: true }
})

async function curiousPlay(uid: string): Promise<CuriousVisitor[]> {
  const db = getFirestore()
  const snap = await db.collection(`playReveals/${uid}/by`).orderBy('at', 'desc').limit(100).get()
  const visitors: CuriousVisitor[] = []
  for (const d of snap.docs) {
    if (visitors.length >= CURIOUS_LIMIT) break
    const otherUid = d.id
    if (otherUid.startsWith('zbot-')) continue // real people only
    const [likers, live, userSnap, play] = await Promise.all([
      likersInMode(uid, otherUid, 'play'),
      livePlayMatchOf(uid, otherUid),
      db.collection('users').doc(otherUid).get(),
      playDataOf(otherUid),
    ])
    // Liked (either side, in Play) or matched: Flames / Chats cover them.
    if (likers.length > 0 || live) continue
    const user = userSnap.data()
    if (!user || (await isSuspendedUid(otherUid, user)) || !(await playStatus(otherUid)).access) continue
    if (await blockedEitherWay(uid, otherUid)) continue
    const playId = await ensurePlayId(otherUid)
    const pub = publicPlayProfile(otherUid, playId, play, user)
    const scores = await loadPlayScores(uid, otherUid)
    visitors.push({
      playId,
      displayName: pub.playDisplayName || 'Someone',
      photoURL: pub.photoURLs?.[0] ?? null,
      age: pub.age ?? null,
      locationLabel: null,
      intent: 'play',
      sparkScore: null,
      sparkEnoughInfo: null,
      engineVersion: null,
      playScore: typeof scores?.playScore === 'number' ? scores.playScore : null,
      tier1Spark: null,
      at: typeof d.get('at') === 'number' ? d.get('at') : 0,
    })
  }
  return visitors
}

// Bot chats: "typing…" while a bot reply is on its way (see botTyping.ts).
export { botTypingStart, botTypingStartPlay, botTypingStop, botTypingStopPlay } from './botTyping'
export { computeBehaviorScore, getPastConnections, onMatchBehaviorUpdate, onPlayMatchBehaviorUpdate, purgePreservedChats, unmatchConnection } from './behavior'
export { markChatPhotoViewed, sweepChatPhotos } from './photos'
export { checkTrialStatus, onMarketOpened } from './trial'
export { mirrorPlan } from './userData'
export { acknowledgeLegalUpdate, recordTermsAcceptance } from './legal'
export { getPhotoUrls, getReviewPdfUrl } from './photoAccess'
export { exploreOnInternal, exploreOnLocation, exploreOnUser, exploreOnUserDoc, getExploreDeck } from './explore'
export { photoCleanupOnUser, photoCleanupOnUserDoc } from './photoCleanup'
export { checkPlayPin, getPlayPinStatus, setPlayPin } from './playPin'
export { getUsage } from './usage'
export { retireBotsOnCityClose } from './botRetire'
export { entitlementOnLocation, entitlementOnMatching } from './playAccess'

// How many people are waiting in "who liked you". §4.A3: the app now uses
// getLikes (likerPreview.ts); this stays for app versions from before it,
// with the count only — curated likes are listed by getLikes (by like id),
// no longer here by uid.
export const getLikeCount = onCall({ timeoutSeconds: 15, invoker: 'public' }, async (request): Promise<{ count: number; bots: { id: string; data: DocumentData }[] }> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  await requireActive(uid)
  const mode = (request.data as Record<string, unknown> | null)?.mode === 'play' ? 'play' : 'spark'
  if (mode === 'play') await requirePlayAccess(uid)
  await takeRateLimit(uid, 'likeList', { max: 120, windowMs: 10 * 60 * 1000 })
  // Blocked, suspended and deleted likers aren't counted.
  const now = Date.now()
  const live = (await listLikes(uid, mode)).filter((l) => !l.entry.curated && !l.entry.dismissed && l.raw.isExpired !== true && (l.entry.expiresAt === null || l.entry.expiresAt > now))
  return { count: live.length, bots: [] }
})
export { playAccessOnPlan, playAccessOnPlayProfile, playAccessOnProfile } from './playAccess'
export { identityGuardOnIdentity, identityGuardOnMatching, identityGuardOnUser } from './identityGuard'
export { actOnPlayConnection, listLockedPlayConnections } from './lockedPlay'
export { getDistances, grantSmsConsent, recordActivity, refreshAges, setLocation } from './location'
export { createCheckoutSession, createPortalSession, stripeWebhook } from './stripe'
export { twilioInbound } from './smsInbound'
export {
  broadcastToFounders,
  getFounderThread,
  getFounderThreads,
  markFounderThreadRead,
  replyToFounder,
  sendFounderMessage,
} from './founderMessages'
export { acceptPhotoConsent, getBlockedUsers, onBeforeSignIn, unblockMember } from './trust'
export { adminGetReports, adminModerate, liftExpiredSuspensions, reportAndBan, submitReport } from './reports'

// ─── SMS notifications ───────────────────────────────────────────────────────
// Opt-in texts (Settings → Notifications). Each checks the recipient's
// master switch for that mode (smsNotificationsEnabled.spark|play), the per-kind preference and their quiet
// hours (a text in quiet hours is dropped, not delayed); sendSMS
// never throws, so a texting problem never affects the write that fired it.

const MESSAGE_SMS_COOLDOWN_MS = 5 * 60 * 1000

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
      target,
      play
        ? "🔥 Someone's interested on Zylove Play. Check your Flames. zylove.app/sparks"
        : '✦ Someone feels a Spark with you on Zylove. Open your Sparks to see more. zylove.app/sparks',
    )
  },
)

// New message: texts the other participant, at most once per match every
// 5 minutes and, across all their matches, once per recipient every 30
// minutes and 10 a day (F-089). Protocol and system messages don't count,
// and neither do bot chats — a bot reply never texts anyone. F-062: Play messages (under
// playMatches, sender = Play ID) the same way, through loadMatch.
async function textOnMessage(matchId: string, msg: DocumentData | undefined): Promise<void> {
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

  const ctx = await loadMatch(matchId)
  const match = ctx?.data
  if (!ctx || !match || match.isBlocked === true || match.isBot === true) return
  const sender = ctx.uidOf(senderId)
  const recipientUid = sender ? ctx.otherOf(sender) : null
  if (!sender || !recipientUid) return
  const play = ctx.play || match.mode === 'play'

  const target = await smsTarget(recipientUid, 'newMessage', play ? 'play' : 'spark')
  if (!target) return

  // Claim the cooldown slots before sending, so a burst of messages sends one
  // text: the match's (5 minutes) and the recipient's across all matches
  // (F-089: one per 30 minutes, 10 a day — decideMessageSms).
  const db = getFirestore()
  const recipientRef = internalRef(recipientUid)
  const claimed = await db.runTransaction(async (tx) => {
    const [matchSnap, recipientSnap] = await Promise.all([tx.get(ctx.ref), tx.get(recipientRef)])
    const now = Date.now()
    const last = millis(matchSnap.data()?.lastMessageSmsAt)
    if (last !== null && now - last < MESSAGE_SMS_COOLDOWN_MS) return false
    const cap = decideMessageSms(recipientSnap.data()?.messageSms, now)
    if (!cap.send || !cap.next) return false
    tx.update(ctx.ref, { lastMessageSmsAt: FieldValue.serverTimestamp() })
    tx.set(recipientRef, { messageSms: cap.next }, { merge: true })
    return true
  })
  if (!claimed) return

  const senderName = await nameFor(sender, play ? undefined : match.participantSnapshots, play ? 'play' : match.mode)
  await sendSMS(target, `💬 ${senderName} sent you a message on Zylove. zylove.app/matches`)
}

export const smsOnMessage = onDocumentCreated(
  { document: 'matches/{matchId}/messages/{messageId}', secrets: SMS_SECRETS },
  async (event) => textOnMessage(event.params.matchId, event.data?.data()),
)
export const smsOnPlayMessage = onDocumentCreated(
  { document: 'playMatches/{matchId}/messages/{messageId}', secrets: SMS_SECRETS },
  async (event) => textOnMessage(event.params.matchId, event.data?.data()),
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
          : `✦ Sparks are flying. You and ${await nameFor(otherUid, match.participantSnapshots, match.mode)} connected on Zylove. zylove.app/matches`
        await sendSMS(target, body)
      }),
    )
  },
)
// F-062: a Play match (its people from the server-only record).
export const smsOnPlayMatch = onDocumentCreated(
  { document: 'playMatches/{matchId}', secrets: SMS_SECRETS },
  async (event) => {
    const ctx = await loadMatch(event.params.matchId)
    if (!ctx || ctx.users.length !== 2) return
    await Promise.all(
      ctx.users.map(async (uid) => {
        const target = await smsTarget(uid, 'newMatch', 'play')
        if (target) await sendSMS(target, "🔥 You're now entangled on Zylove Play. zylove.app/matches")
      }),
    )
  },
)

// Quiet chat nudge: in-app only (ConversationNudge in the chat) while the
// A2P campaign covers account and match/message texts only. The old
// nudgeQuietChats SMS job is retired; add it back once the campaign allows it.

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

const PHONE_LOOKUP_DAILY_BUDGET = 1000

// Runs before the OTP is sent so VoIP / virtual / landline numbers can't sign
// up. Callable without auth (it gates sign-in). Order: every limit first —
// per number, then per caller address — so the answer can't be used to probe
// which numbers have accounts (F-072: the address limit used to come after
// the account check, so once a caller was over it "allowed" meant "has an
// account"). Then existing accounts skip the paid Lookup (the same
// { allowed: true } a new mobile number gets), then the daily Lookup budget,
// then the Lookup itself. Fails open on a Lookup or Firestore error, but not
// once the budget is spent.
export const PHONE_IP_LIMIT = 30

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
    // Stage B (F-054): also per caller address (new random numbers each time
    // got past the per-number limit). F-072: for every number, existing
    // accounts included, and before the account check.
    const ipKey = ipRateKey(clientIp(request.rawRequest as never))
    // 30 an hour: existing accounts count now, and several people can share
    // one address (a carrier's NAT) — still a hard ceiling per real address,
    // which can't be spoofed since F-073.
    const perIp = await takeRateLimit(ipKey, 'phoneLookup', { max: PHONE_IP_LIMIT, windowMs: 60 * 60 * 1000 }).then(() => true, () => false)
    if (!perIp) {
      logger.info('validatePhoneNumber: rate limited (address)')
      return { allowed: false, reason: 'rate_limited' }
    }

    // Existing users are never refused by the budget, and don't cost a Lookup.
    if (await phoneHasAccount(phoneNumber)) return { allowed: true }

    // A daily Lookup budget (Stage B). F-072: past it, new numbers get the
    // generic "try again later" — allowing them unchecked let VoIP numbers
    // through once someone had spent the budget.
    const day = new Date().toISOString().slice(0, 10)
    const budgetRef = getFirestore().doc(`rateLimits/_phoneLookup_${day}`)
    const spent = await getFirestore()
      .runTransaction(async (tx) => {
        const n = ((await tx.get(budgetRef)).get('count') as number | undefined) ?? 0
        if (n >= PHONE_LOOKUP_DAILY_BUDGET) return false
        tx.set(budgetRef, { count: n + 1 }, { merge: true })
        return true
      })
      .catch(() => true)
    if (!spent) {
      logger.warn('validatePhoneNumber: daily Lookup budget reached — refusing new numbers')
      return { allowed: false, reason: 'rate_limited' }
    }

    const lineType = await lookupLineType(phoneNumber)
    if (lineType !== null && BLOCKED_LINE_TYPES.has(lineType)) {
      logger.info('validatePhoneNumber: blocked', { lineType })
      return { allowed: false, reason: 'voip' }
    }
    return { allowed: true }
  },
)

// ─── Ported from the mobile codebase (Stage 0) ───────────────────────────────
// Deployed source moved into this codebase unchanged (see legacy/legacyOptions.ts
// for the one edit: pinned runtime settings). Batch (a): account deletion.
export { deleteAccount, checkRestoreEligibility, restoreAccount } from './legacy/accountLifecycle'
export { requestAccountDeletion, cancelAccountDeletion } from './legacy/trustSafety'
export { onNightlyPurge, processGraceExpiredDeletions } from './legacy/onNightlyPurge'
// Batch (b): photo moderation, pair rescoring, women's Elite.
export { onPhotoUpload } from './legacy/onPhotoUpload'
export { onMatchingPrefsWrite, onPlayProfileWrite, onPrivateProfileWrite, onProfileWrite, sweepRescores } from './legacy/onProfileWrite'
export { claimWomenElite } from './legacy/claimWomenElite'
// Batch (c): Explore taps and likes, swipes, blocking.
export { onTap } from './legacy/onTap'
export { onLike } from './legacy/onLike'
export { dismissLike, getLikerPreview, getLikes } from './likerPreview'
export { recordSwipe } from './legacy/recordSwipe'
export { blockUser, unblockUser } from './legacy/trustSafety'
// Batch (d): demo-mode bot chat replies.
export { onBotMessage, onBotPlayMessage } from './legacy/onBotMessage'
export { purgeAdminAudit } from './audit'
export { purgeOpenerHashes, trustOnMessage, trustOnPlayMessage } from './trustSignals'
export { purgeDeviceSightings, recordDevice } from './devices'
export { computeTrustScores, trustOnSignals } from './trustScore'
export { adminSearchUsers, adminTrustAction, adminTrustDetail, adminTrustQueue, adminViewProfile } from './trustAdmin'
// T&S Phase 2: anti-scam.
export { purgeScamTraps } from './scamTraps'
export { refreshGeoDb } from './geo'
export { adminGetProbation, adminSetProbation } from './probation'
// T&S Phase 3: contact exchange.
export { requestContactExchange, respondContactExchange, revokeContactExchange } from './contactExchange'
// T&S Phase 4: franking, the evidence locker, appeals.
export { frankOnMessage, frankOnPlayMessage } from './franking'
export { adminLockerDecide, adminLockerDetail, adminLockerHold, adminLockerList, getEvidencePdf, purgeEvidence, submitEvidence } from './evidence'
export { adminDecideAppeal, adminListAppeals, submitAppeal } from './appeals'
// Privacy-policy retention (dry run until config/retention.enabled).
export { purgeRetention } from './retention'
export {
  adminAlertOnAccountCreated,
  adminAlertOnPlayProfile,
  adminAlertOnProfile,
  adminAlertOnQueue,
  adminNotificationStatus,
  adminSetNotificationSettings,
  flushAdminAlerts,
  warnExpiringEvidence,
} from './adminAlerts'
// The /contact form (server-side, rate limited) and the admin inbox.
export { adminDeleteContactMessage, adminListContactMessages, adminSetContactHandled, submitContactMessage } from './contactMessages'
// F-082: CSP violation reports (aggregated counts only) and their admin view.
export { adminCspReports, cspReport } from './cspReports'
// T&S Phase 5: duplicate photos.
export { photoHashOnDelete } from './photoHashTrigger'
// F-062: private Play IDs — the public Play profile and the Play chat key.
export { getMyPlayId, playProfileOnUser, playProfileOnWrite, publishPlayKey } from './playProfiles'
