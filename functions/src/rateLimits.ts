import { HttpsError } from 'firebase-functions/v2/https'
import { getFirestore } from 'firebase-admin/firestore'

// Per-user call limits for read-heavy callables, in rateLimits/{uid}
// (server-only: the rules' default deny). Kept out of userInternal so these
// frequent writes don't fire mirrorPlan. A sliding window of timestamps per key.
export async function takeRateLimit(uid: string, key: string, { max, windowMs }: { max: number; windowMs: number }): Promise<void> {
  const db = getFirestore()
  const ref = db.doc(`rateLimits/${uid}`)
  await db.runTransaction(async (tx) => {
    const now = Date.now()
    const raw: unknown = (await tx.get(ref)).data()?.[key]
    const recent = (Array.isArray(raw) ? raw : []).filter((t): t is number => typeof t === 'number' && now - t < windowMs)
    if (recent.length >= max) throw new HttpsError('resource-exhausted', 'Too many requests. Try again in a few minutes.')
    tx.set(ref, { [key]: [...recent, now] }, { merge: true })
  })
}

// Takes up to `n` from the same kind of window and returns how many it got
// (0 when the window is full) — for counting things revealed in a batch.
export async function takeRateLimitUpTo(uid: string, key: string, n: number, { max, windowMs }: { max: number; windowMs: number }): Promise<number> {
  if (n <= 0) return 0
  const db = getFirestore()
  const ref = db.doc(`rateLimits/${uid}`)
  return db.runTransaction(async (tx) => {
    const now = Date.now()
    const raw: unknown = (await tx.get(ref)).data()?.[key]
    const recent = (Array.isArray(raw) ? raw : []).filter((t): t is number => typeof t === 'number' && now - t < windowMs)
    const take = Math.max(0, Math.min(n, max - recent.length))
    if (take > 0) tx.set(ref, { [key]: [...recent, ...Array.from({ length: take }, () => now)] }, { merge: true })
    return take
  })
}
