import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'
import { displayScore, likeProfile, parseTier1, passProfile, type DiscoverProfile, type DisplayScore } from './discover'
import type { Mode } from '../store/modeStore'

// §4.A3 — who liked you, without who: the server names each like by an
// opaque like id (getLikes) and never sends the liker's uid or Play ID until
// you're linked. Spark+ and Elite see a preview (getLikerPreview: photo,
// first name, bio, prompts); Free sees how many people, and curated
// profiles' likes (no paid feature involves a bot).
export interface SparkEntry {
  likeId: string
  likedAt: number
  mode: Mode
  dismissed: boolean
  // The pair's score saved with the like. Null for curated profiles (their
  // seeded likes carry a placeholder).
  compatibilityScore: number | null
  expiresAt: number | null // epoch ms
  isWeeklySpark: boolean
  // A Zylove curated profile.
  isBot: boolean
}

interface LikeRaw {
  likeId: string
  mode: Mode
  likedAt: number
  dismissed: boolean
  isWeeklySpark: boolean
  expiresAt: number | null
  compatibilityScore: number | null
  curated: boolean
}

function toSpark(r: LikeRaw): SparkEntry {
  return {
    likeId: r.likeId,
    likedAt: r.likedAt,
    mode: r.mode === 'play' ? 'play' : 'spark',
    dismissed: r.dismissed,
    compatibilityScore: r.compatibilityScore,
    expiresAt: r.expiresAt,
    isWeeklySpark: r.isWeeklySpark,
    isBot: r.curated,
  }
}

export interface SparkQueue {
  // Real people waiting (live — not passed on), on every plan.
  count: number
  live: SparkEntry[]
  viewed: SparkEntry[]
}

// The queue for one mode: Weekly Spark first, then newest first; the ones
// you passed on ("Viewed") apart. Free: `live`/`viewed` hold curated likes only.
export async function fetchSparkQueue(mode: Mode): Promise<SparkQueue> {
  const { data } = await httpsCallable<{ mode: Mode }, { count: number; likes: LikeRaw[] }>(functions, 'getLikes')({ mode })
  const live: SparkEntry[] = []
  const viewed: SparkEntry[] = []
  for (const r of data.likes) {
    const s = toSpark(r)
    ;(s.dismissed ? viewed : live).push(s)
  }
  // Stable sort keeps the newest-first order within each group.
  live.sort((a, b) => Number(b.isWeeklySpark) - Number(a.isWeeklySpark) || b.likedAt - a.likedAt)
  viewed.sort((a, b) => b.likedAt - a.likedAt)
  return { count: data.count, live, viewed }
}

// For the nav dot: the queue polled while the app is open (the queue itself
// is server-only, so there's no listener to attach).
const POLL_MS = 2 * 60 * 1000
export function subscribeSparks(
  _uid: string,
  mode: Mode,
  onChange: (sparks: SparkEntry[], count: number) => void,
  onError: (err: Error) => void,
): () => void {
  let stopped = false
  const load = () =>
    fetchSparkQueue(mode).then(
      (q) => !stopped && onChange(q.live, q.count),
      (err: Error) => !stopped && onError(err),
    )
  void load()
  const timer = setInterval(load, POLL_MS)
  const onFocus = () => document.visibilityState === 'visible' && void load()
  document.addEventListener('visibilitychange', onFocus)
  return () => {
    stopped = true
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onFocus)
  }
}

export interface LikerPrompt {
  promptId: string
  answer: string
  question?: string
}

// What a like shows before you link — nothing that says who they are beyond
// it (no uid, no age, no place).
export interface LikerPreview {
  mode: Mode
  firstName: string
  // The image itself (a data: URL) or a plain web address.
  photo: string | null
  bio: string
  prompts: LikerPrompt[]
  curated: boolean
}

// One preview per like for the session (the card and the detail view share it).
const previews = new Map<string, Promise<LikerPreview>>()
export function fetchLikerPreview(likeId: string): Promise<LikerPreview> {
  let p = previews.get(likeId)
  if (!p) {
    p = httpsCallable<{ likeId: string }, { preview: LikerPreview }>(functions, 'getLikerPreview')({ likeId }).then((r) => r.data.preview)
    p.catch(() => previews.delete(likeId))
    previews.set(likeId, p)
  }
  return p
}

// "Not for me": the like moves to Viewed.
export async function dismissSpark(likeId: string): Promise<void> {
  await httpsCallable<{ likeId: string }, { success: true }>(functions, 'dismissLike')({ likeId })
}

// Liking back someone in your queue is mutual by definition. The server
// resolves the like id, records your like (the same path as onLike) and
// creates the match; only then does it say who they are (partnerId: their
// uid in Spark, Play ID in Play).
export async function likeBackSpark(spark: SparkEntry): Promise<{ matchId: string; partnerId: string }> {
  const { data } = await httpsCallable<{ likeId: string }, { matched: true; matchId: string; partnerId: string }>(
    functions,
    'likeBack',
  )({ likeId: spark.likeId })
  previews.delete(spark.likeId)
  return { matchId: data.matchId, partnerId: data.partnerId }
}

// ─── Sent ────────────────────────────────────────────────────────────────────

// F-062: a Play entry's uid holds the Play ID.
export interface SentSpark {
  uid: string
  name: string
  age: number | null
  photoURL: string | null
  score: DisplayScore | null
  likedAt: number
}

interface SentSparkRaw {
  uid?: string
  playId?: string
  displayName: string
  age: number | null
  photoURL: string | null
  sparkScore: number | null
  sparkEnoughInfo: boolean | null
  engineVersion: number | null
  playScore: number | null
  tier1Spark: unknown
  likedAt: number
}

// Your likes that haven't become links yet, for this mode. Pairs can't be
// queried from the client, so the getSentSparks callable gathers them.
export async function fetchSentSparks(mode: Mode): Promise<SentSpark[]> {
  const { data } = await httpsCallable<{ mode: Mode }, { sent: SentSparkRaw[] }>(functions, 'getSentSparks')({ mode })
  return data.sent.map((s) => ({
    uid: s.playId ?? s.uid ?? '',
    name: s.displayName,
    age: s.age,
    photoURL: s.photoURL,
    score: displayScore(
      {
        pairId: '',
        sparkScore: s.sparkScore ?? undefined,
        sparkEnoughInfo: s.sparkEnoughInfo ?? undefined,
        engineVersion: s.engineVersion ?? undefined,
        playScore: s.playScore ?? undefined,
        tier1: parseTier1(s.tier1Spark),
      },
      mode,
    ),
    likedAt: s.likedAt,
  }))
}

// ─── From a profile page ─────────────────────────────────────────────────────

// Sends a spark from outside Explore and Sparks (/profile/:uid). If they
// already liked you, onLike makes it a match (§4.A3: the app can't look
// them up in your queue any more).
export async function sparkFromProfile(
  uid: string,
  mode: Mode,
  profile: DiscoverProfile,
): Promise<{ matched: boolean; matchId: string | null }> {
  const result = await likeProfile(uid, mode, profile)
  return {
    matched: result.matched,
    // Same fallback as Explore: the match id is the sorted uid pair (Spark;
    // a Play match's id always comes from the server).
    matchId: result.matched ? (result.matchId ?? (mode === 'play' ? null : [uid, profile.uid].sort().join('_'))) : null,
  }
}

// Passing also moves their like (if any) to Viewed — server-side, in recordSwipe.
export async function passFromProfile(uid: string, mode: Mode, targetUid: string): Promise<void> {
  await passProfile(uid, mode, targetUid)
}

// ─── Curious ─────────────────────────────────────────────────────────────────

export interface CuriousVisitor {
  uid: string
  profile: DiscoverProfile // name, age, photo, place, intent — enough for a card
  score: DisplayScore | null
}

export interface CuriousResult {
  // Locked for free and Spark+ men: count only, no names or photos.
  locked: boolean
  count: number // capped at CURIOUS_MAX
  visitors: CuriousVisitor[]
}

export const CURIOUS_MAX = 20

interface CuriousRaw {
  uid?: string
  playId?: string
  displayName: string
  age: number | null
  photoURL: string | null
  locationLabel: string | null
  intent: string | null
  sparkScore: number | null
  sparkEnoughInfo: boolean | null
  engineVersion: number | null
  playScore: number | null
  tier1Spark: unknown
}

// People who opened your compatibility score first (getCuriousVisitors), in
// this mode — in Play with their Play name and photo.
export async function fetchCurious(mode: Mode): Promise<CuriousResult> {
  const { data } = await httpsCallable<{ mode: Mode }, { locked: boolean; count: number; visitors: CuriousRaw[] }>(
    functions,
    'getCuriousVisitors',
  )({ mode })
  return {
    locked: data.locked,
    count: data.count,
    visitors: data.visitors.map((v) => ({
      uid: v.playId ?? v.uid ?? '',
      profile: {
        uid: v.playId ?? v.uid ?? '',
        displayName: v.displayName,
        age: v.age ?? undefined,
        photoURLs: v.photoURL ? [v.photoURL] : [],
        locationLabel: v.locationLabel ?? undefined,
        intent: (v.intent ?? undefined) as DiscoverProfile['intent'],
      },
      score: displayScore(
        {
          pairId: '',
          sparkScore: v.sparkScore ?? undefined,
          sparkEnoughInfo: v.sparkEnoughInfo ?? undefined,
          engineVersion: v.engineVersion ?? undefined,
          playScore: v.playScore ?? undefined,
          tier1: parseTier1(v.tier1Spark),
        },
        mode,
      ),
    })),
  }
}
