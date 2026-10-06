import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
  type QueryConstraint,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { friendlyError } from './errors'
import { db, functions } from './firebase'
import { getDistances, type Distance } from './distances'
import { loadAccountView, marketOf } from './subscription'
import { cityConfigPath, type ZyloveCity } from '../config/cities'
import { genderToAttractedToCategory } from '../utils/genderUtils'
import type { DatingProfile } from '../types/profile'
import type { Mode } from '../store/modeStore'
import { loadPlayProfile, parsePlayProfile, type PlayProfileData } from './playProfile'
import { playNameOf } from './displayNames'
import { loadBlockedUids } from './safety'

const CANDIDATE_LIMIT = 50
// Below this many eligible profiles, a load tops up from further queries.
const MIN_CANDIDATES = 20
// radiusMiles missing on the profile; null means "No limit".
const DEFAULT_RADIUS_MILES = 25
const BOT_PREFIX = 'zbot-'

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

// ─── Swiped list (per user + mode, this browser only) ───────────────────────

function swipedKey(uid: string, mode: Mode): string {
  return `zylove_swiped_${uid}_${mode}`
}

export function loadSwiped(uid: string, mode: Mode): Set<string> {
  try {
    const raw = localStorage.getItem(swipedKey(uid, mode))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function markSwiped(uid: string, mode: Mode, targetUid: string): void {
  try {
    const list = [...loadSwiped(uid, mode)]
    if (!list.includes(targetUid)) list.push(targetUid)
    // Cap so the key can't grow without bound (mobile keeps the last 500).
    localStorage.setItem(swipedKey(uid, mode), JSON.stringify(list.slice(-500)))
  } catch {
    // Storage unavailable (private mode etc.) — the card still advances.
  }
}

// ─── Already acted on (server records) ──────────────────────────────────────

const SWIPES_LIMIT = 500

// People this user already liked, passed or linked with in this mode, from
// the server, so a new device (empty localStorage) doesn't show them again.
// swipes/{id} ({ swiperId, swipedId, action, mode }) is written by
// recordSwipe; matches are readable by their participants. Either read may
// be refused by the rules or fail — then it just contributes nothing.
async function loadActedOn(uid: string, mode: Mode): Promise<Set<string>> {
  const [swipes, matches] = await Promise.all([
    getDocs(query(collection(db, 'swipes'), where('swiperId', '==', uid), limit(SWIPES_LIMIT))).catch(() => null),
    getDocs(query(collection(db, 'matches'), where('users', 'array-contains', uid))).catch(() => null),
  ])
  const acted = new Set<string>()
  for (const d of swipes?.docs ?? []) {
    const s = d.data()
    // Older swipes have no mode; they count for both.
    if (typeof s.swipedId === 'string' && (s.mode === undefined || s.mode === mode)) acted.add(s.swipedId)
  }
  for (const d of matches?.docs ?? []) {
    const m = d.data()
    if ((m.mode === 'play' ? 'play' : 'spark') !== mode) continue
    const users: unknown = m.users ?? m.participants
    if (Array.isArray(users)) for (const u of users) if (typeof u === 'string' && u !== uid) acted.add(u)
  }
  return acted
}

// ─── Viewer profile ──────────────────────────────────────────────────────────

const myProfileRequests = new Map<string, Promise<DiscoverProfile | null>>()

// The signed-in user's own profile, for side-by-side comparisons. Cached for
// the session so each compatibility block doesn't refetch it.
export function fetchMyProfile(uid: string): Promise<DiscoverProfile | null> {
  let request = myProfileRequests.get(uid)
  if (!request) {
    request = getDoc(doc(db, 'users', uid)).then((snap) =>
      snap.exists() ? { ...(snap.data() as DiscoverProfile), uid } : null,
    )
    request.catch(() => myProfileRequests.delete(uid))
    myProfileRequests.set(uid, request)
  }
  return request
}

// ─── Filtering ───────────────────────────────────────────────────────────────

function asList(v: string[] | string | undefined): string[] {
  if (Array.isArray(v)) return v
  return v ? [v] : []
}

// The public age (birthdays are private; the server keeps age current).
export function displayAge(p: DiscoverProfile): number | null {
  return p.age ? p.age : null
}

// Bilateral attraction: each side's attractedTo must include the other's
// gender category (off-map identities use matchableAs).
function mutuallyAttracted(me: DiscoverProfile, them: DiscoverProfile): boolean {
  const meAs = genderToAttractedToCategory(me.genderIdentity ?? '', me.matchableAs)
  const themAs = genderToAttractedToCategory(them.genderIdentity ?? '', them.matchableAs)
  const theyWantMe = asList(them.attractedTo)
  const iWantThem = asList(me.attractedTo)
  return (
    (theyWantMe.includes('everyone') || theyWantMe.some((a) => meAs.includes(a))) &&
    (iWantThem.includes('everyone') || iWantThem.some((a) => themAs.includes(a)))
  )
}

function intentMatchesMode(p: DiscoverProfile, mode: Mode): boolean {
  return p.intent === mode || p.intent === 'open'
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Explore candidates. The pool is read from a random point in sortKey order so
// each load sees a different slice; if too few survive the filters it wraps
// around from the start, then falls back to an unordered read (which also
// reaches profiles that don't have a sortKey yet, or works while the index
// builds). Results are filtered here, not in the queries.
export async function fetchCandidates(uid: string, mode: Mode): Promise<DiscoverProfile[]> {
  const view = await loadAccountView(uid)
  if (!view) return []
  const me = { ...(view as DiscoverProfile), uid }
  const myCity = marketOf(view)

  const [blocked, founding, actedOn] = await Promise.all([loadBlockedUids(uid), inFoundingPeriod(myCity), loadActedOn(uid, mode)])
  const swiped = new Set([...loadSwiped(uid, mode), ...actedOn])
  const eligible = (p: DiscoverProfile) => isEligible(me, p, mode, swiped, blocked, founding)
  const distances = new Map<string, Distance>()

  const users = collection(db, 'users')
  const notSuspended = where('isSuspended', '==', false)
  const passes: QueryConstraint[][] = [
    [notSuspended, orderBy('sortKey'), startAfter(Math.random()), limit(CANDIDATE_LIMIT)],
    [notSuspended, orderBy('sortKey'), limit(CANDIDATE_LIMIT)],
    [notSuspended, limit(CANDIDATE_LIMIT)],
  ]

  const found = new Map<string, DiscoverProfile>()
  for (const constraints of passes) {
    if (found.size >= MIN_CANDIDATES) break
    const snap = await getDocs(query(users, ...constraints)).catch(() => null)
    const fresh = (snap?.docs ?? []).map((d) => ({ ...(d.data() as DiscoverProfile), uid: d.id })).filter((p) => !found.has(p.uid) && eligible(p))
    // Distances for this pass's survivors, then the distance setting.
    for (const [u, d] of await getDistances(fresh.map((p) => p.uid))) distances.set(u, d)
    for (const p of fresh) {
      const d = distances.get(p.uid)
      if (!founding && !withinRadius(me, d)) continue
      found.set(p.uid, d ? { ...p, distanceMiles: d.miles } : p)
    }
  }

  // Everyone left has photos, so "photos first" is already satisfied.
  const located = [...found.values()]
  return localFirst(myCity, distances, mode === 'play' ? await withPlayProfiles(located) : located)
}

function isEligible(
  me: DiscoverProfile,
  p: DiscoverProfile,
  mode: Mode,
  swiped: Set<string>,
  blocked: Set<string>,
  founding: boolean,
): boolean {
  const visibilityField = mode === 'play' ? 'playVisibility' : 'sparkVisibility'
  if (p.uid === me.uid || swiped.has(p.uid) || blocked.has(p.uid)) return false
  if (!p.photoURLs?.length) return false
  if (!intentMatchesMode(p, mode)) return false
  if (p[visibilityField] === 'paused' || p[visibilityField] === 'hidden') return false
  const age = displayAge(p)
  if (age !== null && me.ageMin && me.ageMax && (age < me.ageMin || age > me.ageMax)) return false
  // Founding period: everyone, any distance, bots included. Once the
  // viewer's city is live: their distance setting (fetchCandidates), and no
  // bots.
  if (!founding && p.uid.startsWith(BOT_PREFIX)) return false
  return mutuallyAttracted(me, p)
}

// Max distance from Settings → Discovery, once the viewer's city is live.
// Skipped when either side has no location (missing data never hides
// anyone).
function withinRadius(me: DiscoverProfile, d: Distance | undefined): boolean {
  if (me.radiusMiles === null || !d) return true
  const radius = typeof me.radiusMiles === 'number' && me.radiusMiles > 0 ? me.radiusMiles : DEFAULT_RADIUS_MILES
  return d.miles <= radius
}

// Founding period: the viewer's launch city hasn't filled its founding
// circle yet (config/city_{id}.botsActive isn't false). Until it has, Explore
// shows everyone at any distance, bots included (they're the preview of
// Zylove), so a new city never looks empty. Viewers outside every launch
// city, without a location, or whose config can't be read are always in it.
// Settings → Discovery locks the distance control on the same check.
export async function inFoundingPeriod(city: ZyloveCity | null): Promise<boolean> {
  if (!city) return true
  const snap = await getDoc(doc(db, cityConfigPath(city.id))).catch(() => null)
  return snap?.data()?.botsActive !== false
}

// A soft sort, never a filter, each group shuffled:
//   1. real people local to the viewer — same launch city, or within
//      LOCAL_MILES when the viewer isn't in one
//   2. bots (Austin-seeded, shown to everyone) as filler
//   3. everyone else
// Without coordinates, a location label naming the viewer's city counts.
const LOCAL_MILES = 50

function isLocal(myCity: ZyloveCity | null, d: Distance | undefined, p: DiscoverProfile): boolean {
  if (d) return myCity ? d.sameMarket : d.miles <= LOCAL_MILES
  return !!myCity && p.locationLabel?.split(',')[0]?.trim().toLowerCase() === myCity.name.toLowerCase()
}

function localFirst(myCity: ZyloveCity | null, distances: Map<string, Distance>, candidates: DiscoverProfile[]): DiscoverProfile[] {
  const bots = candidates.filter((p) => p.uid.startsWith(BOT_PREFIX))
  const real = candidates.filter((p) => !p.uid.startsWith(BOT_PREFIX))
  const local = real.filter((p) => isLocal(myCity, distances.get(p.uid), p))
  const rest = real.filter((p) => !local.includes(p))
  return [...shuffle(local), ...shuffle(bots), ...shuffle(rest)]
}

// Play Explore only shows people with a Play profile, and shows them with it:
// everyone left after the filters gets their playProfile/data read in
// parallel (bot or not, whatever their intent). No Play profile, no Play
// photos, or an unreadable one, means they're left out — never Spark data in
// Play.
async function withPlayProfiles(candidates: DiscoverProfile[]): Promise<DiscoverProfile[]> {
  const play = await Promise.all(
    candidates.map((p) =>
      getDoc(doc(db, `users/${p.uid}/playProfile/data`))
        .then((snap) => (snap.exists() ? parsePlayProfile(snap.data()) : null))
        .catch(() => null),
    ),
  )
  return candidates.flatMap((p, i) => {
    const playProfile = play[i]
    // Play Explore shows the Play name everywhere the card, details or match
    // overlay read displayName.
    return playProfile?.photoURLs.length ? [{ ...p, playProfile, displayName: playNameOf(p, playProfile) || 'Someone' }] : []
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

// Same snapshot shape the mobile app and botEngine write; the match lists on
// both apps read name/photo/age from here. A Play match gets the Play name
// and Play photo (no Play photo → none, never the Spark one).
function participantSnapshot(
  p: DiscoverProfile,
  play: PlayProfileData | null,
): { displayName: string; age: number | null; photoURL: string | null } {
  return {
    displayName: (play ? playNameOf(p, play) : p.displayName) || 'Someone',
    age: displayAge(p),
    photoURL: (play ? play.photoURLs[0] : p.photoURLs?.[0]) ?? null,
  }
}

// onLike creates matches/{id} without participantSnapshots, so the liker's
// client fills them in on a new match.
async function writeParticipantSnapshots(matchId: string, uid: string, mode: Mode, target: DiscoverProfile): Promise<void> {
  const isPlay = mode === 'play'
  const [meSnap, myPlay, theirPlay] = await Promise.all([
    getDoc(doc(db, 'users', uid)),
    isPlay ? loadPlayProfile(uid) : Promise.resolve(null),
    isPlay ? (target.playProfile ?? loadPlayProfile(target.uid)) : Promise.resolve(null),
  ])
  if (!meSnap.exists()) return
  const me = { ...(meSnap.data() as DiscoverProfile), uid }
  // An empty Play profile still keeps the snapshot on the Play side.
  const empty = isPlay ? parsePlayProfile({}) : null
  await setDoc(
    doc(db, 'matches', matchId),
    {
      participantSnapshots: {
        [uid]: participantSnapshot(me, myPlay ?? empty),
        [target.uid]: participantSnapshot(target, theirPlay ?? empty),
      },
    },
    { merge: true },
  )
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
  if (data.matched && data.matchId) {
    // The match already exists; a failed snapshot write only degrades the list row.
    await writeParticipantSnapshots(data.matchId, uid, mode, target).catch((err: unknown) =>
      console.warn('Failed to write participantSnapshots', err),
    )
  }
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
  const snap = await getDoc(doc(db, 'pairs', [uid, targetUid].sort().join('_'))).catch(() => null)
  const tier1: unknown = snap?.data()?.tier1Play
  const archetype = typeof tier1 === 'object' && tier1 !== null ? parseArchetype((tier1 as Record<string, unknown>).archetype) : null
  const copy = archetype ? PLAY_ARCHETYPE_COPY[archetype.id] : undefined
  return archetype && copy ? { ...archetype, ...copy } : null
}
