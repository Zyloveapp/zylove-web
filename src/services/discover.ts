import { doc, getDoc, type DocumentData } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { friendlyError } from './errors'
import { db, functions } from './firebase'
import { primeDistances } from './distances'
import { primePhotoUrls } from './photoUrls'
import { loadMatching } from './privateMatching'
import type { DatingProfile } from '../types/profile'
import type { Mode } from '../store/modeStore'
import { parsePlayProfile, type PlayProfileData } from './playProfile'
import { playNameOf } from './displayNames'
import { isPlayId } from './playId'

// Firestore docs are written by several clients over time, so every field is
// treated as possibly missing. attractedTo was a single string on older docs.
// F-062: in Play, `uid` holds the card's Play ID — Play never sees a uid.
export type DiscoverProfile = Partial<Omit<DatingProfile, 'attractedTo'>> & {
  uid: string
  // Play: a curated profile (its public Play profile says so).
  curated?: boolean
  attractedTo?: string[] | string
  sparkVisibility?: string
  playVisibility?: string
  // Play Explore only: the candidate's playProfile/data, used for display.
  playProfile?: PlayProfileData
  // Max distance for their Explore feed (Settings → Discovery); null = no limit.
  radiusMiles?: number | null
  // Random 0–1 pool position (see functions/src/discovery.ts).
  sortKey?: number
  // Set on candidates when both people have a saved location (whole miles,
  // from the server: services/distances.ts).
  distanceMiles?: number
}

// ─── Swiped this session ─────────────────────────────────────────────────────
// The server keeps who's been acted on (exploreState, Stage 3) and leaves
// them out of the deck. This in-memory copy only covers a deck fetched while
// a swipe is still on its way. Stage B: nothing is kept in localStorage (old
// zylove_swiped_* keys are cleared on sign-out).

const swipedThisSession = new Map<string, Set<string>>()

export function loadSwiped(uid: string, mode: Mode): Set<string> {
  return new Set(swipedThisSession.get(`${uid}:${mode}`) ?? [])
}

export function markSwiped(uid: string, mode: Mode, targetUid: string): void {
  const key = `${uid}:${mode}`
  const set = swipedThisSession.get(key) ?? new Set<string>()
  set.add(targetUid)
  swipedThisSession.set(key, set)
}

// ─── Viewer profile ──────────────────────────────────────────────────────────

const myProfileRequests = new Map<string, Promise<DiscoverProfile | null>>()

// The signed-in user's own profile, for side-by-side comparisons. Cached for
// the session so each compatibility block doesn't refetch it.
export function fetchMyProfile(uid: string): Promise<DiscoverProfile | null> {
  let request = myProfileRequests.get(uid)
  if (!request) {
    // With their own matching preferences (private/matching, Stage 3).
    request = getDoc(doc(db, 'users', uid)).then(async (snap) =>
      snap.exists() ? { ...(snap.data() as DiscoverProfile), ...((await loadMatching(uid, snap.data())) as Partial<DiscoverProfile>), uid } : null,
    )
    request.catch(() => myProfileRequests.delete(uid))
    myProfileRequests.set(uid, request)
  }
  return request
}

// ─── Explore deck ────────────────────────────────────────────────────────────

// The public age (birthdays are private; the server keeps age current).
export function displayAge(p: DiscoverProfile): number | null {
  return p.age ? p.age : null
}

// Explore candidates, from the server (getExploreDeck, Stage 3): it applies
// every filter Explore uses — mutual attraction, age range, distance,
// visibility, blocks, people already liked or passed, Play access — and
// orders them local first. Nobody's preferences, location or the user list
// reach the browser. The deck only advances as the user swipes (calls without
// swiping return the same cards), so it can't be used to page through
// everyone. Photo URLs and distances come with it.
// Spark: uid + public profile. Play (F-062): the Play ID and the public Play
// profile (its age, curated) only.
interface DeckCard {
  uid?: string
  playId?: string
  profile?: DocumentData
  playProfile?: DocumentData
  distanceMiles: number | null
  sameMarket: boolean
}

export async function fetchCandidates(uid: string, mode: Mode): Promise<DiscoverProfile[]> {
  const { data } = await httpsCallable<
    { mode: Mode },
    { cards: DeckCard[]; photoUrls: Record<string, string>; expiresAt: number; exhausted: boolean }
  >(functions, 'getExploreDeck')({ mode })
  primePhotoUrls(data.photoUrls, data.expiresAt)
  const idOf = (c: DeckCard) => c.playId ?? c.uid ?? ''
  primeDistances(data.cards.flatMap((c) => (c.distanceMiles === null ? [] : [[idOf(c), { miles: c.distanceMiles, sameMarket: c.sameMarket }] as const])))
  // A swipe this browser just made may not have reached the server yet.
  const swiped = loadSwiped(uid, mode)
  return data.cards.filter((c) => idOf(c) && !swiped.has(idOf(c))).map((c) => {
    const distance = c.distanceMiles !== null ? { distanceMiles: c.distanceMiles } : {}
    if (mode !== 'play' || !c.playProfile) return { ...(c.profile as DiscoverProfile), uid: idOf(c), ...distance }
    // F-062: a Play card is its Play profile and age — nothing from Spark.
    const raw = c.playProfile
    const playProfile = parsePlayProfile(raw)
    return {
      uid: idOf(c),
      ...distance,
      age: typeof raw.age === 'number' && raw.age > 0 ? raw.age : undefined,
      curated: raw.curated === true,
      playProfile,
      // Play Explore shows the Play name everywhere the card, details or
      // match overlay read displayName.
      displayName: playNameOf(playProfile) || 'Someone',
    } as DiscoverProfile
  })
}

// ─── Explore deck across mode switches ───────────────────────────────────────

// The card on screen in each mode's Explore. Someone open to both modes can
// be in both decks — and with few local people, head both — so a deck never
// opens on the person just on screen in the other mode.
const onScreen: Partial<Record<Mode, string>> = {}

export function noteOnScreen(mode: Mode, uid: string): void {
  onScreen[mode] = uid
}

// A deck built while the mode transition plays, so Explore opens the new
// mode on an already-reshuffled deck. Used once, and only while fresh.
const PREPARED_TTL_MS = 60_000
const prepared = new Map<string, { at: number; deck: Promise<DiscoverProfile[]> }>()

export function prepareDeck(uid: string, mode: Mode): void {
  const deck = fetchCandidates(uid, mode)
  deck.catch(() => {}) // takeDeck reports failures; an unused deck stays quiet
  prepared.set(`${uid}:${mode}`, { at: Date.now(), deck })
}

// Explore's deck for the mode: the prepared one, else a fresh fetch (each
// is its own shuffle), with whoever was just on screen in the other mode
// moved to the back.
export async function takeDeck(uid: string, mode: Mode): Promise<DiscoverProfile[]> {
  const key = `${uid}:${mode}`
  const ready = prepared.get(key)
  prepared.delete(key)
  const profiles = await (ready && Date.now() - ready.at < PREPARED_TTL_MS ? ready.deck : fetchCandidates(uid, mode))
  const justSeen = onScreen[mode === 'play' ? 'spark' : 'play']
  if (!justSeen) return profiles
  return [...profiles.filter((p) => p.uid !== justSeen), ...profiles.filter((p) => p.uid === justSeen)]
}

// ─── Actions (deployed Callables) ────────────────────────────────────────────

interface RecordSwipeRequest {
  targetUid: string
  action: 'like' | 'pass' | 'maybe'
  mode: Mode
}

interface OnLikeRequest {
  likedUserId: string
  mode: Mode
}

export interface OnLikeResponse {
  matched: boolean
  pairId?: string // Spark only (F-062: never in Play — it's the uid pair)
  matchId: string | null
}

// ─── Compatibility (onTap Callable) ──────────────────────────────────────────

// Category scores are 0–100. Spark: coreFit, valuesIntentions, physicalPrefs,
// loveLanguages, lifestyle, personality. Play: nonNegotiables,
// physicalCompatibility, energyVibe, intentionsLimits.
// Tier 1 facet scoring (Spark only — onTap returns the pair's tier1Spark).
// The server only emits clear matches (tier1/archetypes.ts MIN_CONFIDENCE);
// F-098: it no longer sends the confidence itself.
export interface ArchetypeMatch {
  id: string
  label: string
  copy: string
}

// F-098: Deep Fit as the server shows it (scoring.ts publicDeepFit) — no raw
// floats, confidence or coverage.
export interface Tier1Result {
  archetype: ArchetypeMatch | null
  combinedScore: number | null // rounded
  // |A→B − B→A| as a band: 0 under 5 points, 1 up to 10, 2 up to 20, 3 above.
  asymmetryBand: number | null
  // Engine v2 Deep Fit detail (Elite): fitFor[uid] = how well the other
  // person fits that uid (in bands of 5); where the pair lines up and
  // differs most.
  fitFor: Record<string, number>
  strengths: string[]
  differences: string[]
}

export interface CompatibilityResult {
  pairId?: string // Spark only
  // Play (F-062): the pair's Play archetype, from the server.
  playArchetype?: unknown
  sparkScore?: number
  // Engine v2: false → too little to go on ("Not enough info").
  sparkEnoughInfo?: boolean
  // The scoring engine behind sparkScore/tier1 (absent: engine v1).
  engineVersion?: number
  playScore?: number
  // null: no data on one side (engine v2 leaves it out).
  breakdown?: { spark?: Record<string, number | null>; play?: Record<string, number> }
  triggeredDealbreakers?: string[]
  tier1?: Tier1Result | null
  // The viewed person has physical preferences to score against (their
  // preferences themselves are private, Stage 3).
  hasPhysicalPrefs?: boolean
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function parseArchetype(v: unknown): ArchetypeMatch | null {
  if (typeof v !== 'object' || v === null) return null
  const a = v as Record<string, unknown>
  if (typeof a.id !== 'string' || typeof a.label !== 'string') return null
  return { id: a.id, label: a.label, copy: typeof a.copy === 'string' ? a.copy : '' }
}

// The band for a raw gap — only for an answer from functions deployed
// before F-098 (they sent asymmetryGap); same thresholds as the server's.
function gapBand(gap: number): number {
  return gap < 5 ? 0 : gap <= 10 ? 1 : gap <= 20 ? 2 : 3
}

// tier1 is server-computed and fail-open (null when scoring it failed), so
// it's validated field by field rather than trusted as typed.
export function parseTier1(v: unknown): Tier1Result | null {
  if (typeof v !== 'object' || v === null) return null
  const t = v as Record<string, unknown>
  return {
    archetype: parseArchetype(t.archetype),
    combinedScore: num(t.combinedScore),
    asymmetryBand: num(t.asymmetryBand) ?? (num(t.asymmetryGap) === null ? null : gapBand(num(t.asymmetryGap)!)),
    fitFor:
      typeof t.fitFor === 'object' && t.fitFor !== null
        ? Object.fromEntries(Object.entries(t.fitFor).filter((e): e is [string, number] => num(e[1]) !== null))
        : {},
    strengths: strings(t.strengths),
    differences: strings(t.differences),
  }
}

// In-flight/completed onTap calls for this session, so the background
// prefetch, the score reveal and likeProfile share a single request.
const compatibilityRequests = new Map<string, Promise<CompatibilityResult>>()

// Computes (or returns the cached) pairs/{a_b} score for the viewer + target.
export function fetchCompatibility(targetUid: string): Promise<CompatibilityResult> {
  let request = compatibilityRequests.get(targetUid)
  if (!request) {
    // F-062: a Play card is asked about by its Play ID (Play scores only).
    request = httpsCallable<{ tappedUserId?: string; tappedPlayId?: string }, Omit<CompatibilityResult, 'tier1'> & { tier1?: unknown }>(
      functions,
      'onTap',
    )(isPlayId(targetUid) ? { tappedPlayId: targetUid } : { tappedUserId: targetUid }).then(({ data }) => ({ ...data, tier1: parseTier1(data.tier1) }))
    // Forget failures so the next call retries.
    request.catch(() => compatibilityRequests.delete(targetUid))
    compatibilityRequests.set(targetUid, request)
  }
  return request
}

// Marks that the viewer actually saw the score (the reveal button, or a full
// report that opens revealed), as opposed to the background prefetch. Feeds
// the other person's "Curious" tab. Failures are ignored — it's a signal,
// not part of the reveal. The mode is the id's: a Play ID is a Play reveal.
export function recordReveal(targetUid: string): void {
  // F-062: a Play reveal is recorded server-side, by Play ID.
  if (isPlayId(targetUid)) {
    httpsCallable(functions, 'recordPlayReveal')({ playId: targetUid }).catch(() => {})
    return
  }
  // F-065: the pair doc is server-only (a client read or update of it said
  // whether it existed).
  httpsCallable(functions, 'recordSparkReveal')({ uid: targetUid }).catch(() => {})
}

// onLike requires the pairs/{a_b} doc that onTap creates, so it's created in
// the background as each profile is shown. Fire-and-forget; the score stays
// hidden until the user reveals it.
export function prefetchCompatibility(targetUid: string): void {
  fetchCompatibility(targetUid).catch(() => {})
}

// Safety net for profiles saved without trust/safety defaults (e.g. the
// post-onboarding initUserDefaults call failed). Idempotent server-side.
// Fire-and-forget: never blocks or fails the Discover load.
export function ensureUserDefaults(): void {
  httpsCallable(functions, 'initUserDefaults')({}).catch(() => {})
}

// "Maybe" keeps the card in the deck; the server only counts it (safety
// signals: how someone swipes). Fire-and-forget.
export function maybeProfile(mode: Mode, targetUid: string): void {
  httpsCallable<RecordSwipeRequest, { success: boolean }>(functions, 'recordSwipe')({ targetUid, action: 'maybe', mode }).catch(() => {})
}

export async function passProfile(uid: string, mode: Mode, targetUid: string): Promise<void> {
  await httpsCallable<RecordSwipeRequest, { success: boolean }>(functions, 'recordSwipe')({
    targetUid,
    action: 'pass',
    mode,
  })
  markSwiped(uid, mode, targetUid)
}

export async function likeProfile(uid: string, mode: Mode, target: DiscoverProfile): Promise<OnLikeResponse> {
  // Make sure the pair doc exists (usually already done by the prefetch).
  await fetchCompatibility(target.uid).catch(() => {})
  const { data } = await httpsCallable<OnLikeRequest, OnLikeResponse>(functions, 'onLike')({
    likedUserId: target.uid,
    mode,
  })
  markSwiped(uid, mode, target.uid)
  // Server record of the like (as mobile does), so other devices skip them
  // too. Best effort: the like itself is already saved.
  httpsCallable<RecordSwipeRequest, { success: boolean }>(functions, 'recordSwipe')({
    targetUid: target.uid,
    action: 'like',
    mode,
  }).catch(() => {})
  // The server writes the match's name/photo snapshots (onLike, Stage A:
  // clients can't write them any more).
  return data
}

export function actionErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError && err.code === 'functions/permission-denied') return 'Your account can’t do that right now.'
  return friendlyError(err)
}

// ─── Displayed score ─────────────────────────────────────────────────────────

// The server's scoring engine (functions/src/legacy/scoring.ts
// SCORE_ENGINE_VERSION). Engine v2 and later scores are calibrated, capped
// and come with a "Not enough info" flag; older ones keep the old display
// rules until they're re-scored. F-100: v3 (intent no longer scored) reads
// the same as v2 — any later version does, so the app can ship first.
export const CALIBRATED_ENGINE_VERSION = 2
export const isCalibratedEngine = (v: number | undefined): boolean => typeof v === 'number' && v >= CALIBRATED_ENGINE_VERSION

export type ScoreLabel = 'Strong fit' | 'Good fit' | 'Some differences' | 'Not enough info'

// Spark bands (engine v2).
export function scoreLabel(value: number): ScoreLabel {
  if (value >= 75) return 'Strong fit'
  if (value >= 60) return 'Good fit'
  return 'Some differences'
}

export interface DisplayScore {
  value: number | null // 0–100, rounded; null = "Not enough info"
  deep: boolean // true when this is the Deep Fit (tier1) score
  label: ScoreLabel | null // Spark, engine v2; null for Play and engine v1
}

// The one compatibility number shown anywhere. Engine v2: the pair's
// sparkScore — Deep Fit's headline, the same for every plan (plans differ
// in the explanation, not the number). Engine v1 (until re-scored): the
// base score (F-098: Deep Fit's dataConfidence, which once let it headline,
// is no longer sent). Always 0–100.
export function displayScore(result: CompatibilityResult, mode: Mode): DisplayScore | null {
  if (mode === 'play') {
    return typeof result.playScore === 'number' ? { value: clampScore(result.playScore), deep: false, label: null } : null
  }
  if (isCalibratedEngine(result.engineVersion)) {
    if (result.sparkEnoughInfo === false) return { value: null, deep: true, label: 'Not enough info' }
    if (typeof result.sparkScore !== 'number') return null
    const value = clampScore(result.sparkScore)
    return { value, deep: true, label: scoreLabel(value) }
  }
  return typeof result.sparkScore === 'number' ? { value: clampScore(result.sparkScore), deep: false, label: null } : null
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

// ─── Play archetype ──────────────────────────────────────────────────────────

// Copy for the Play archetypes the scoring engine emits (tier1/archetypes.ts).
const PLAY_ARCHETYPE_COPY: Record<string, { label: string; copy: string }> = {
  intense_pair: { label: 'Intense Pair', copy: "The energy between you two doesn't need explaining." },
  talkers_first: { label: 'Talkers First', copy: 'The conversation will be just as electric as everything else.' },
  same_frequency: { label: 'Same Frequency', copy: "You're tuned to the same channel. Rare." },
  curious_and_willing: { label: 'Curious & Willing', copy: "You're both open to where this goes. That's the whole point." },
  slow_burn: { label: 'Slow Burn', copy: 'No rush. You both like to let it build.' },
  fully_present: { label: 'Fully Present', copy: 'You both notice the small things. It shows.' },
  playful_pair: { label: 'Playful Pair', copy: 'Easy laughs, light touch. You both lead with fun.' },
  wild_cards: { label: 'Wild Cards', copy: "Both up for something new. Expect a story or two." },
}

// The pair's Play archetype, or null. F-062: from onTap by the other
// person's Play ID (the pair's records are server-only).
export async function fetchPlayArchetype(_uid: string, targetId: string): Promise<ArchetypeMatch | null> {
  if (!isPlayId(targetId)) return null
  const result = await fetchCompatibility(targetId).catch(() => null)
  const archetype = parseArchetype(result?.playArchetype)
  const copy = archetype ? PLAY_ARCHETYPE_COPY[archetype.id] : undefined
  return archetype && copy ? { ...archetype, ...copy } : null
}
