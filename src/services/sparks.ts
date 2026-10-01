import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from './firebase'
import { likeProfile, participantSnapshot, type DiscoverProfile } from './discover'
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
  }
}

// Live queue for one mode, newest first. Dismissed/expired entries are
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
      const sparks = snap.docs
        .filter((d) => {
          const data = d.data()
          return data.dismissed !== true && data.isExpired !== true
        })
        .map((d) => toSpark(d.id, d.data()))
        .filter((s) => s.mode === mode)
      onChange(sparks)
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

// Liking back someone in your queue is mutual by definition. onLike only
// knows about likes recorded in pairs/{a_b}, which mobile and bot likes never
// write — so when it doesn't report a match, the match is created here the
// way the mobile app does it, and both queue entries are consumed.
export async function likeBackSpark(uid: string, spark: SparkEntry, profile: DiscoverProfile): Promise<string> {
  const result = await likeProfile(uid, spark.mode, profile)
  const matchId = result.matched && result.matchId ? result.matchId : [uid, spark.likerUid].sort().join('_')

  if (!result.matched) {
    const matchRef = doc(db, 'matches', matchId)
    const existing = await getDoc(matchRef)
    if (!existing.exists()) {
      const meSnap = await getDoc(doc(db, 'users', uid))
      const me: DiscoverProfile = { ...(meSnap.data() as DiscoverProfile | undefined), uid }
      await setDoc(matchRef, {
        matchId,
        users: [uid, spark.likerUid].sort(),
        participantSnapshots: {
          [uid]: participantSnapshot(me),
          [spark.likerUid]: participantSnapshot(profile),
        },
        mode: spark.mode,
        matchedAt: serverTimestamp(),
        lastMessagePreview: null,
        hasUnread: false,
        isBlocked: false,
      })
    }
  }

  await Promise.allSettled([
    deleteDoc(doc(db, `users/${uid}/likeQueue/${spark.likerUid}`)),
    deleteDoc(doc(db, `users/${spark.likerUid}/likeQueue/${uid}`)),
  ])
  return matchId
}
