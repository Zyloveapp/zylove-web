import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { getStorage } from 'firebase-admin/storage'
import { getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { defaultBucket, isPhotoRef } from './storagePath'
import { isAdminAuth, requireActive } from './userData'
import { takeRateLimit } from './rateLimits'
import { audit } from './audit'
import { playStatus } from './playAccess'

// Profile photos (F-021). Firestore holds each photo's Storage path
// ("photos/{uid}/{spark|play}/{file}"), and Storage lets only the owner and
// admins read those files. Everyone else gets a short-lived signed URL from
// here, and only for a photo they may see:
//
//   • their own photos, published or still in review
//   • admins: any photo
//   • anyone else's published photo (in that user's photoURLs for the
//     mode — root doc for Spark, playProfile/data for Play), when that user
//     isn't suspended or deleted and neither has blocked the other — and, for
//     a Play photo, when both have Play access (Stage 2, playAccess.ts)
//
// Photos in review, rejected or removed are never handed out to others.
// URLs are signed for the current clock hour and expire at the end of the
// next one, so every viewer gets the same URL within an hour (browser cache
// hits) and any URL dies within two hours.

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
    await requireActive(request.auth.uid)
    const viewer = request.auth.uid
    const raw = (request.data as Record<string, unknown> | null)?.refs
    if (!Array.isArray(raw) || raw.length > MAX_REFS || !raw.every(isPhotoRef)) {
      throw new HttpsError('invalid-argument', `refs must be up to ${MAX_REFS} photo paths`)
    }
    await takeRateLimit(viewer, 'photos', { max: 300, windowMs: 10 * 60 * 1000 })
    const refs = [...new Set(raw as string[])]
    const admin = isAdminAuth(request.auth)
    const db = getFirestore()
    // T&S Phase 1: an admin viewing other people's photos is audited (by
    // owner; never the paths themselves).
    const others = [...new Set(refs.map((r) => ownerOf(r).uid))].filter((u) => u !== viewer)
    if (admin && others.length) {
      await Promise.all(others.map((u) => audit({ actor: viewer, action: 'photo.view', target: u, detail: { count: refs.filter((r) => ownerOf(r).uid === u).length } })))
    }

    // Everything about each owner the checks need, read once.
    const owners = [...new Set(refs.map((r) => ownerOf(r).uid))].filter((u) => u !== viewer)
    const info = new Map<string, { root?: DocumentData; play?: DocumentData; blocked: boolean }>()
    if (!admin && owners.length) {
      const [roots, plays, theyBlocked, iBlocked, internals] = await Promise.all([
        db.getAll(...owners.map((u) => db.doc(`users/${u}`))),
        db.getAll(...owners.map((u) => db.doc(`users/${u}/playProfile/data`))),
        db.getAll(...owners.map((u) => db.doc(`users/${u}/blockedUsers/${viewer}`))),
        db.getAll(...owners.map((u) => db.doc(`users/${viewer}/blockedUsers/${u}`))),
        db.getAll(...owners.map((u) => db.doc(`userInternal/${u}`))),
      ])
      // Suspension is in userInternal (Stage 3); older root copies count.
      owners.forEach((u, i) =>
        info.set(u, {
          root: roots[i].exists ? { ...roots[i].data(), isSuspended: internals[i].data()?.isSuspended ?? roots[i].data()?.isSuspended } : undefined,
          play: plays[i].data(),
          blocked: theyBlocked[i].exists || iBlocked[i].exists,
        }),
      )
    }

    // Play photos: the viewer and the owner both need Play access.
    const playOwners = [...new Set(refs.filter((r) => ownerOf(r).mode === 'play').map((r) => ownerOf(r).uid))].filter((u) => u !== viewer)
    const playOk = new Map<string, boolean>()
    if (!admin && playOwners.length) {
      const viewerPlay = (await playStatus(viewer)).access
      for (const u of playOwners) playOk.set(u, viewerPlay && (await playStatus(u)).access)
    }

    const allowed = refs.filter((ref) => {
      const { uid, mode } = ownerOf(ref)
      if (admin || uid === viewer) return true
      const o = info.get(uid)
      if (!o?.root || o.blocked) return false
      if (o.root.isSuspended === true || o.root.isDeleted === true) return false
      if (mode === 'play') return playOk.get(uid) === true && published(o.play, ref)
      // A Spark photo is published on the root doc. (Play-only accounts used
      // to mirror Play photos there; only Play rules apply to those.)
      return published(o.root, ref)
    })

    return signPhotoRefs(allowed)
  },
)

// Signs photo paths the caller has already cleared (getPhotoUrls above, the
// Explore deck): the same URL for everyone within the hour, gone within two.
export async function signPhotoRefs(refs: string[]): Promise<{ urls: Record<string, string>; expiresAt: number }> {
  const hourStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
  const expires = hourStart + 2 * HOUR_MS
  const bucket = getStorage().bucket(defaultBucket())
  const signed = await Promise.all(
    [...new Set(refs)].filter(isPhotoRef).map((ref) =>
      bucket
        .file(ref)
        .getSignedUrl({ version: 'v4', action: 'read', accessibleAt: new Date(hourStart), expires })
        .then(([url]) => [ref, url] as const)
        .catch(() => null),
    ),
  )
  return { urls: Object.fromEntries(signed.filter((s): s is readonly [string, string] => s !== null)), expiresAt: expires }
}

// ─── Review PDFs (F-033) ─────────────────────────────────────────────────────

// A short-lived link to one of the caller's own "How's my profile?" PDFs
// (reviews/{uid}/{mode}/{reviewId}.pdf). Replaces getDownloadURL, whose token
// link worked for anyone who had it, forever. Admins may open any.
const PDF_RE = /^reviews\/([^/]+)\/(spark|play)\/[A-Za-z0-9_-]+\.pdf$/
const PDF_TTL_MS = 15 * 60 * 1000

export const getReviewPdfUrl = onCall(
  { timeoutSeconds: 20, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ url: string }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const path = (request.data as Record<string, unknown> | null)?.pdfPath
    const m = typeof path === 'string' ? PDF_RE.exec(path) : null
    if (!m || typeof path !== 'string') throw new HttpsError('invalid-argument', 'pdfPath must be a review PDF path')
    if (m[1] !== request.auth.uid && !isAdminAuth(request.auth)) throw new HttpsError('permission-denied', 'Not your review.')
    if (m[1] !== request.auth.uid) await audit({ actor: request.auth.uid, action: 'review_pdf.download', target: m[1] })
    await takeRateLimit(request.auth.uid, 'reviewPdf', { max: 30, windowMs: 10 * 60 * 1000 })
    const file = getStorage().bucket(defaultBucket()).file(path)
    if (!(await file.exists())[0]) throw new HttpsError('not-found', 'That review PDF no longer exists.')
    const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + PDF_TTL_MS })
    return { url }
  },
)
