import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  type DocumentData,
  type Unsubscribe,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { displayScore, likeProfile, parseTier1, type DiscoverProfile, type DisplayScore } from './discover'
import type { Mode } from '../store/modeStore'

// users/{uid}/likeQueue/{likerUid} — people who liked this user. Written by
// the mobile app and botEngine: { likerUid, likedAt (epoch ms), mode,
// dismissed, isExpired, compatibilityScore, likerProfile: {...snapshot} }.
export interface SparkEntry {
  likerUid: string
  likedAt: number
  mode: Mode
  // Snapshot of the liker taken at like time, shaped like a profile doc.
  profile: DiscoverProfile
  compatibilityScore: number | null
  expiresAt: number | null // epoch ms
  isWeeklySpark: boolean
  // Bots (uid prefix 'zbot-') are shown unblurred, as normal profiles.
  isBot: boolean
}

function toSpark(id: string, data: DocumentData): SparkEntry {
  const likerUid = typeof data.likerUid === 'string' && data.likerUid ? data.likerUid : id
  const snap: Record<string, unknown> =
    typeof data.likerProfile === 'object' && data.likerProfile !== null ? data.likerProfile : {}
  const photoURLs = Array.isArray(snap.photoURLs)
    ? snap.photoURLs.filter((u): u is string => typeof u === 'string' && u !== '')
    : []
  if (photoURLs.length === 0 && typeof snap.photoURL === 'string' && snap.photoURL) photoURLs.push(snap.photoURL)
  return {
    likerUid,
    likedAt: typeof data.likedAt === 'number' ? data.likedAt : 0,
    mode: data.mode === 'play' ? 'play' : 'spark',
    profile: { ...(snap as Partial<DiscoverProfile>), uid: likerUid, photoURLs },
    compatibilityScore:
      typeof data.compatibilityScore === 'number' && data.compatibilityScore > 0 ? data.compatibilityScore : null,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null,
    isWeeklySpark: data.isWeeklySpark === true,
    isBot: likerUid.startsWith('zbot-'),
  }
}

// Live queue for one mode: Weekly Spark first, then newest first.
// Dismissed/expired entries (including ones past expiresAt) are
// filtered here rather than in the query (same as mobile's getLikeQueue):
// older docs lack the flags, and an inequality filter would drop them and
// conflict with ordering by likedAt.
export function subscribeSparks(
  uid: string,
  mode: Mode,
  onChange: (sparks: SparkEntry[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const q = query(collection(db, `users/${uid}/likeQueue`), orderBy('likedAt', 'desc'))
  return onSnapshot(
    q,
    (snap) => {
      const now = Date.now()
      const sparks = snap.docs
        .filter((d) => {
          const data = d.data()
          return data.dismissed !== true && data.isExpired !== true
        })
        .map((d) => toSpark(d.id, d.data()))
        .filter((s) => s.mode === mode && (s.expiresAt === null || s.expiresAt > now))
        // Stable sort keeps the likedAt order within each group.
        .sort((a, b) => Number(b.isWeeklySpark) - Number(a.isWeeklySpark))
      onChange(sparks)
    },
    onError,
  )
}

// Live queue plus the entries the user passed on ("Viewed"), for one mode.
// Same client-side filtering as subscribeSparks; expired entries are dropped
// from both.
export function subscribeSparkQueue(
  uid: string,
  mode: Mode,
  onChange: (queue: { live: SparkEntry[]; viewed: SparkEntry[] }) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const q = query(collection(db, `users/${uid}/likeQueue`), orderBy('likedAt', 'desc'))
  return onSnapshot(
    q,
    (snap) => {
      const now = Date.now()
      const live: SparkEntry[] = []
      const viewed: SparkEntry[] = []
      for (const d of snap.docs) {
        const data = d.data()
        if (data.isExpired === true) continue
        const s = toSpark(d.id, data)
        if (s.mode !== mode || (s.expiresAt !== null && s.expiresAt <= now)) continue
        ;(data.dismissed === true ? viewed : live).push(s)
      }
      // Stable sort keeps the likedAt order within each group.
      live.sort((a, b) => Number(b.isWeeklySpark) - Number(a.isWeeklySpark))
      onChange({ live, viewed })
    },
    onError,
  )
}

// Same fields mobile's dismissLike writes.
export async function dismissSpark(uid: string, likerUid: string): Promise<void> {
  await updateDoc(doc(db, `users/${uid}/likeQueue/${likerUid}`), { dismissed: true, dismissedAt: Date.now() })
}

// Full, current profile for the detail view; falls back to the snapshot.
export async function loadSparkProfile(spark: SparkEntry): Promise<DiscoverProfile> {
  const snap = await getDoc(doc(db, 'users', spark.likerUid))
  if (!snap.exists()) return spark.profile
  return { ...spark.profile, ...(snap.data() as DiscoverProfile), uid: spark.likerUid }
}

// Liking back someone in your queue is mutual by definition, but onLike only
// knows about likes recorded in pairs/{a_b} (mobile and bot likes never write
// there). onLike still runs to keep pairs in sync; the likeBack callable then
// creates the match if onLike didn't and consumes both queue entries — writes
// the client's Firestore rules don't allow.
export async function likeBackSpark(uid: string, spark: SparkEntry, profile: DiscoverProfile): Promise<string> {
  await likeProfile(uid, spark.mode, profile)
  const { data } = await httpsCallable<{ likerUid: string; mode: Mode }, { matched: true; matchId: string }>(
    functions,
    'likeBack',
  )({ likerUid: spark.likerUid, mode: spark.mode })
  return data.matchId
}

// ─── Sent ────────────────────────────────────────────────────────────────────

export interface SentSpark {
  uid: string
  name: string
  age: number | null
  photoURL: string | null
  score: DisplayScore | null
  likedAt: number
}

interface SentSparkRaw {
  uid: string
  displayName: string
  age: number | null
  photoURL: string | null
  sparkScore: number | null
  playScore: number | null
  tier1Spark: unknown
  likedAt: number
}

// Your likes that haven't become links yet, for this mode. Pairs can't be
// queried from the client, so the getSentSparks callable gathers them.
export async function fetchSentSparks(mode: Mode): Promise<SentSpark[]> {
  const { data } = await httpsCallable<{ mode: Mode }, { sent: SentSparkRaw[] }>(functions, 'getSentSparks')({ mode })
  return data.sent.map((s) => ({
    uid: s.uid,
    name: s.displayName,
    age: s.age,
    photoURL: s.photoURL,
    score: displayScore(
      {
        pairId: '',
        sparkScore: s.sparkScore ?? undefined,
        playScore: s.playScore ?? undefined,
        tier1: parseTier1(s.tier1Spark),
      },
      mode,
    ),
    likedAt: s.likedAt,
  }))
}
