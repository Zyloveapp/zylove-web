import { FieldValue, getFirestore, type DocumentData, type DocumentReference } from 'firebase-admin/firestore'
import { playPairDataRef, playPairUsers } from './pairPlay'
import { playIdOf } from './playIds'

// Likes per mode (Stage A): who liked whom in which mode, server-only. A
// match needs a like from each side IN THE SAME MODE — a Spark like never
// completes a Play match or the other way round.
//   Spark  pairs/{pairId}/likes/spark = { likedBy: [uid] } (the rules' default deny)
//   Play   playPairData/{pA_pB}.likedBy (pairPlay.ts) — F-065: keyed by the
//          Play IDs, never under the uid pair
// Stage B: the pair doc keeps no like state at all; older pairs' userALiked /
// userBLiked are moved here by scripts/migrate-stageB.mjs.

export type LikeMode = 'spark' | 'play'

const db = () => getFirestore()
export const pairIdOf = (a: string, b: string) => [a, b].sort().join('_')
const sparkLikesRef = (a: string, b: string) => db().doc(`pairs/${pairIdOf(a, b)}/likes/spark`)
// Where Play likes were before F-065 (moved by scripts/migrate-f065.mjs).
const legacyPlayLikesRef = (a: string, b: string) => db().doc(`pairs/${pairIdOf(a, b)}/likes/play`)

// `uid` likes the other of the two (a, b) in `mode`.
export async function recordLike(a: string, b: string, mode: LikeMode, uid: string): Promise<void> {
  if (mode === 'spark') {
    await sparkLikesRef(a, b).set({ likedBy: FieldValue.arrayUnion(uid) }, { merge: true })
    return
  }
  await (await playPairDataRef(a, b)).set({ users: playPairUsers(a, b), likedBy: FieldValue.arrayUnion(uid) }, { merge: true })
}

// Who liked in `mode` between a and b.
export async function likersInMode(a: string, b: string, mode: LikeMode): Promise<string[]> {
  const read = async (ref: DocumentReference) => {
    const v: unknown = (await ref.get()).get('likedBy')
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string') : []
  }
  if (mode === 'spark') return read(sparkLikesRef(a, b))
  const [now, before] = await Promise.all([read(await playPairDataRef(a, b)), read(legacyPlayLikesRef(a, b))])
  return [...new Set([...now, ...before])]
}

// Whether `liker` liked `target` in `mode`. Likes from before per-mode
// records count when the pair's flag is set and the like-queue entry they
// left for `target` (server-written) is in this mode.
export async function likedInMode(liker: string, target: string, mode: LikeMode, pair?: DocumentData): Promise<boolean> {
  if ((await likersInMode(liker, target, mode)).includes(liker)) return true
  const p = pair ?? (await db().doc(`pairs/${pairIdOf(liker, target)}`).get()).data()
  if (!p) return false
  const legacyFlag = p.userA === liker ? p.userALiked === true : p.userB === liker ? p.userBLiked === true : false
  if (!legacyFlag) return false
  const entry = (await db().doc(`users/${target}/likeQueue/${liker}`).get()).data()
  return !!entry && (entry.mode === 'play' ? 'play' : 'spark') === mode
}

// After an unmatch or a block: both likes in that mode are gone, so liking
// again can't bring the match back without the other person liking again.
// F-062: Play likes in the queue are keyed by the liker's Play ID.
export async function clearLikes(a: string, b: string, mode: LikeMode | null): Promise<void> {
  const batch = db().batch()
  if (mode !== 'play') batch.delete(sparkLikesRef(a, b))
  batch.delete(db().doc(`users/${a}/likeQueue/${b}`))
  batch.delete(db().doc(`users/${b}/likeQueue/${a}`))
  if (mode !== 'spark') {
    const [pa, pb] = await Promise.all([playIdOf(a), playIdOf(b)])
    if (pa && pb) {
      const ref = await playPairDataRef(a, b)
      if ((await ref.get()).exists) batch.update(ref, { likedBy: FieldValue.delete() })
    }
    batch.delete(legacyPlayLikesRef(a, b))
    if (pb) batch.delete(db().doc(`users/${a}/likeQueue/${pb}`))
    if (pa) batch.delete(db().doc(`users/${b}/likeQueue/${pa}`))
  }
  await batch.commit()
}

// Either person blocked the other (users/{uid}/blockedUsers, server-written).
export async function blockedEitherWay(a: string, b: string): Promise<boolean> {
  const [x, y] = await db().getAll(db().doc(`users/${a}/blockedUsers/${b}`), db().doc(`users/${b}/blockedUsers/${a}`))
  return x.exists || y.exists
}
