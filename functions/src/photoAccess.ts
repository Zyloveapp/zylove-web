import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { getStorage } from 'firebase-admin/storage'
import { getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { defaultBucket, isPhotoRef } from './storagePath'
import { isAdminAuth } from './userData'
import { takeRateLimit } from './rateLimits'

// Profile photos (F-021). Firestore holds each photo's Storage path
// ("photos/{uid}/{spark|play}/{file}"), and Storage lets only the owner and
// admins read those files. Everyone else gets a short-lived signed URL from
// here, and only for a photo they may see:
//
//   • their own photos, published or still in review
//   • admins: any photo
//   • anyone else's published photo (in that user's photoURLs for the
//     mode — root doc for Spark, playProfile/data for Play), when that user
//     isn't suspended or deleted and neither has blocked the other
//
// Photos in review, rejected or removed are never handed out to others.
// URLs are signed for the current clock hour and expire at the end of the
// next one, so every viewer gets the same URL within an hour (browser cache
// hits) and any URL dies within two hours.
// TODO(Stage 2): Play photos only to viewers with Play access.

const MAX_REFS = 120
const HOUR_MS = 60 * 60 * 1000

function ownerOf(ref: string): { uid: string; mode: 'spark' | 'play' } {
  const [, uid, mode] = ref.split('/')
  return { uid, mode: mode as 'spark' | 'play' }
}

function published(doc: DocumentData | undefined, ref: string): boolean {
  const list: unknown = doc?.photoURLs
  return Array.isArray(list) && list.includes(ref)
}

export const getPhotoUrls = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ urls: Record<string, string>; expiresAt: number }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const viewer = request.auth.uid
    const raw = (request.data as Record<string, unknown> | null)?.refs
    if (!Array.isArray(raw) || raw.length > MAX_REFS || !raw.every(isPhotoRef)) {
      throw new HttpsError('invalid-argument', `refs must be up to ${MAX_REFS} photo paths`)
    }
    await takeRateLimit(viewer, 'photos', { max: 300, windowMs: 10 * 60 * 1000 })
    const refs = [...new Set(raw as string[])]
    const admin = isAdminAuth(request.auth)
    const db = getFirestore()

    // Everything about each owner the checks need, read once.
    const owners = [...new Set(refs.map((r) => ownerOf(r).uid))].filter((u) => u !== viewer)
    const info = new Map<string, { root?: DocumentData; play?: DocumentData; blocked: boolean }>()
    if (!admin && owners.length) {
      const [roots, plays, theyBlocked, iBlocked] = await Promise.all([
        db.getAll(...owners.map((u) => db.doc(`users/${u}`))),
        db.getAll(...owners.map((u) => db.doc(`users/${u}/playProfile/data`))),
        db.getAll(...owners.map((u) => db.doc(`users/${u}/blockedUsers/${viewer}`))),
        db.getAll(...owners.map((u) => db.doc(`users/${viewer}/blockedUsers/${u}`))),
      ])
      owners.forEach((u, i) =>
        info.set(u, { root: roots[i].data(), play: plays[i].data(), blocked: theyBlocked[i].exists || iBlocked[i].exists }),
      )
    }

    const allowed = refs.filter((ref) => {
      const { uid, mode } = ownerOf(ref)
      if (admin || uid === viewer) return true
      const o = info.get(uid)
      if (!o?.root || o.blocked) return false
      if (o.root.isSuspended === true || o.root.isDeleted === true) return false
      return published(mode === 'play' ? o.play : o.root, ref)
    })

    const hourStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
    const expires = hourStart + 2 * HOUR_MS
    const bucket = getStorage().bucket(defaultBucket())
    const signed = await Promise.all(
      allowed.map((ref) =>
        bucket
          .file(ref)
          .getSignedUrl({ version: 'v4', action: 'read', accessibleAt: new Date(hourStart), expires })
          .then(([url]) => [ref, url] as const)
          .catch(() => null),
      ),
    )
    return { urls: Object.fromEntries(signed.filter((s): s is readonly [string, string] => s !== null)), expiresAt: expires }
  },
)
