import { doc, getDoc, serverTimestamp, updateDoc, type DocumentData } from 'firebase/firestore'
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

// Firestore docs are written by several clients over time, so every field is
// treated as possibly missing. attractedTo was a single string on older docs.
export type DiscoverProfile = Partial<Omit<DatingProfile, 'attractedTo'>> & {
  uid: string
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
interface DeckCard {
  uid: string
  profile: DocumentData
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
  primeDistances(data.cards.flatMap((c) => (c.distanceMiles === null ? [] : [[c.uid, { miles: c.distanceMiles, sameMarket: c.sameMarket }] as const])))
  // A swipe this browser just made may not have reached the server yet.
  const swiped = loadSwiped(uid, mode)
  return data.cards.filter((c) => !swiped.has(c.uid)).map((c) => {
    const base = { ...(c.profile as DiscoverProfile), uid: c.uid, ...(c.distanceMiles !== null && { distanceMiles: c.distanceMiles }) }
    if (mode !== 'play' || !c.playProfile) return base
    const playProfile = parsePlayProfile(c.playProfile)
    // Play Explore shows the Play name everywhere the card, details or match
    // overlay read displayName.
    return { ...base, playProfile, displayName: playNameOf(playProfile, base) || 'Someone' }
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
  action: 'like' | 'pass'
  mode: Mode
}

interface OnLikeRequest {
  likedUserId: string
  mode: Mode
}

export interface OnLikeResponse {
  matched: boolean
  pairId: string
  matchId: string | null
}

// ─── Compatibility (onTap Callable) ──────────────────────────────────────────

// Category scores are 0–100. Spark: coreFit, valuesIntentions, physicalPrefs,
// loveLanguages, lifestyle, personality. Play: nonNegotiables,
// physicalCompatibility, energyVibe, intentionsLimits.
// Tier 1 facet scoring (Spark only — onTap returns the pair's tier1Spark).
export interface ArchetypeMatch {
  id: string
  label: string
  copy: string
  confidence: number // 0–1; the server only emits matches at ≥ 0.7
}

export interface Tier1Result {
  archetype: ArchetypeMatch | null
  combinedScore: number | null // can exceed 100 from bonus stacking
  asymmetryGap: number | null // |A→B − B→A| in score points
  dataConfidence: number | null
}

export interface CompatibilityResult {
  pairId: string
  sparkScore?: number
  playScore?: number
  breakdown?: { spark?: Record<string, number>; play?: Record<string, number> }
  triggeredDealbreakers?: string[]
  tier1?: Tier1Result | null
  // The viewed person has physical preferences to score against (their
  // preferences themselves are private, Stage 3).
  hasPhysicalPrefs?: boolean
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function parseArchetype(v: unknown): ArchetypeMatch | null {
  if (typeof v !== 'object' || v === null) return null
  const a = v as Record<string, unknown>
  if (typeof a.id !== 'string' || typeof a.label !== 'string') return null
  return { id: a.id, label: a.label, copy: typeof a.copy === 'string' ? a.copy : '', confidence: num(a.confidence) ?? 0 }
}

// tier1 is server-computed and fail-open (null when scoring it failed), so
// it's validated field by field rather than trusted as typed.
export function parseTier1(v: unknown): Tier1Result | null {
  if (typeof v !== 'object' || v === null) return null
  const t = v as Record<string, unknown>
  return {
    archetype: parseArchetype(t.archetype),
    combinedScore: num(t.combinedScore),
    asymmetryGap: num(t.asymmetryGap),
    dataConfidence: num(t.dataConfidence),
  }
}

// In-flight/completed onTap calls for this session, so the background
// prefetch, the score reveal and likeProfile share a single request.
const compatibilityRequests = new Map<string, Promise<CompatibilityResult>>()

// Computes (or returns the cached) pairs/{a_b} score for the viewer + target.
export function fetchCompatibility(targetUid: string): Promise<CompatibilityResult> {
  let request = compatibilityRequests.get(targetUid)
  if (!request) {
    request = httpsCallable<{ tappedUserId: string }, Omit<CompatibilityResult, 'tier1'> & { tier1?: unknown }>(
      functions,
      'onTap',
    )({ tappedUserId: targetUid }).then(({ data }) => ({ ...data, tier1: parseTier1(data.tier1) }))
    // Forget failures so the next call retries.
    request.catch(() => compatibilityRequests.delete(targetUid))
    compatibilityRequests.set(targetUid, request)
  }
  return request
}

// Marks that the viewer actually saw the score (the reveal button, or a full
// report that opens revealed), as opposed to the background prefetch. Feeds
// the other person's "Curious" tab. Only the viewer's own two fields are
// touched; failures are ignored — it's a signal, not part of the reveal.
// `${uid}_revealed_${mode}` records which mode it was seen in, so each mode's
// Curious tab lists only its own visitors (getCuriousVisitors).
export function recordReveal(uid: string, targetUid: string, mode?: Mode): void {
  updateDoc(doc(db, 'pairs', [uid, targetUid].sort().join('_')), {
    [`${uid}_revealed`]: true,
    [`${uid}_revealedAt`]: serverTimestamp(),
    ...(mode ? { [`${uid}_revealed_${mode}`]: true } : {}),
  }).catch(() => {})
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

// Deep Fit (tier1) inflates thin profiles — empty data reads as a perfect
// facet match — so it only becomes the headline score once both people have
// filled in most of the seven tag lists it's built from (5 of 7 ≈ 0.71).
// Above 100 is the uncapped physical bonus stacking, not a real fit, so
// those fall back to the base score too.
const DEEP_FIT_MIN_CONFIDENCE = 0.6

export interface DisplayScore {
  value: number // 0–100, rounded
  deep: boolean // true when this is the Deep Fit (tier1) score
}

// The one compatibility number shown anywhere: Deep Fit when it's trustworthy
// (Spark only), otherwise the base score. Always capped at 100.
export function displayScore(result: CompatibilityResult, mode: Mode): DisplayScore | null {
  const t = mode === 'spark' ? result.tier1 : null
  if (t && t.combinedScore !== null && t.combinedScore <= 100 && (t.dataConfidence ?? 0) >= DEEP_FIT_MIN_CONFIDENCE) {
    return { value: clampScore(t.combinedScore), deep: true }
  }
  const base = mode === 'play' ? result.playScore : result.sparkScore
  return typeof base === 'number' ? { value: clampScore(base), deep: false } : null
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
}

// The pair's Play archetype. onTap only returns the Spark tier1, so this reads
// pairs/{a_b}.tier1Play directly (participants can). Null when there's none.
export async function fetchPlayArchetype(uid: string, targetUid: string): Promise<ArchetypeMatch | null> {
  // Stage 2: Play scores live in pairs/{a_b}/modes/play (participants with
  // Play access); older pairs had them on the pair doc.
  const pairId = [uid, targetUid].sort().join('_')
  const sub = await getDoc(doc(db, `pairs/${pairId}/modes/play`)).catch(() => null)
  const legacy = sub?.exists() ? null : await getDoc(doc(db, 'pairs', pairId)).catch(() => null)
  const tier1: unknown = sub?.data()?.tier1Play ?? legacy?.data()?.tier1Play
  const archetype = typeof tier1 === 'object' && tier1 !== null ? parseArchetype((tier1 as Record<string, unknown>).archetype) : null
  const copy = archetype ? PLAY_ARCHETYPE_COPY[archetype.id] : undefined
  return archetype && copy ? { ...archetype, ...copy } : null
}
