import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'

// Likes per mode (Stage A). pairs/{pairId}/likes/{mode} = { likedBy: [uid] },
// server-only (the rules' default deny): who liked whom in which mode. A
// match needs a like from each side IN THE SAME MODE — a Spark like never
// completes a Play match or the other way round. Stage B: the pair doc keeps
// no like state at all (both people can read it); older pairs' userALiked /
// userBLiked are moved here by scripts/migrate-stageB.mjs.

export type LikeMode = 'spark' | 'play'

const db = () => getFirestore()
export const pairIdOf = (a: string, b: string) => [a, b].sort().join('_')
const likesRef = (pairId: string, mode: LikeMode) => db().doc(`pairs/${pairId}/likes/${mode}`)

export async function recordLike(pairId: string, mode: LikeMode, uid: string): Promise<void> {
  await likesRef(pairId, mode).set({ likedBy: FieldValue.arrayUnion(uid) }, { merge: true })
}

// Whether `liker` liked `target` in `mode`. Likes from before per-mode
// records count when the pair's flag is set and the like-queue entry they
// left for `target` (server-written) is in this mode.
export async function likedInMode(liker: string, target: string, mode: LikeMode, pair?: DocumentData): Promise<boolean> {
  const pairId = pairIdOf(liker, target)
  const likes = (await likesRef(pairId, mode).get()).data()
  if (Array.isArray(likes?.likedBy) && likes.likedBy.includes(liker)) return true
  const p = pair ?? (await db().doc(`pairs/${pairId}`).get()).data()
  if (!p) return false
  const legacyFlag = p.userA === liker ? p.userALiked === true : p.userB === liker ? p.userBLiked === true : false
  if (!legacyFlag) return false
  const entry = (await db().doc(`users/${target}/likeQueue/${liker}`).get()).data()
  return !!entry && (entry.mode === 'play' ? 'play' : 'spark') === mode
}

// After an unmatch or a block: both likes in that mode are gone, so liking
// again can't bring the match back without the other person liking again.
export async function clearLikes(a: string, b: string, mode: LikeMode | null): Promise<void> {
  const pairId = pairIdOf(a, b)
  const batch = db().batch()
  for (const m of mode ? [mode] : (['spark', 'play'] as const)) batch.delete(likesRef(pairId, m))
  batch.delete(db().doc(`users/${a}/likeQueue/${b}`))
  batch.delete(db().doc(`users/${b}/likeQueue/${a}`))
  await batch.commit()
}

// Either person blocked the other (users/{uid}/blockedUsers, server-written).
export async function blockedEitherWay(a: string, b: string): Promise<boolean> {
  const [x, y] = await db().getAll(db().doc(`users/${a}/blockedUsers/${b}`), db().doc(`users/${b}/blockedUsers/${a}`))
  return x.exists || y.exists
}
