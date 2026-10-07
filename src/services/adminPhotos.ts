import { httpsCallable } from 'firebase/functions'
import { auth, functions } from './firebase'

// Admin photo review. Listing and decisions go through admin-gated callables
// (listPendingPhotos / reviewPendingPhoto): other users' docs and Storage
// files are out of a client's reach.

export interface PendingPhoto {
  uid: string
  displayName: string
  mode: 'spark' | 'play'
  url: string
  flaggedAt: number | null
  reason: unknown
}

// Admins carry the `admin` auth claim. The first check in a session refreshes
// the token so a newly granted claim shows up without signing out.
let adminCheck: { uid: string; result: Promise<boolean> } | null = null

export function isAdmin(uid: string): Promise<boolean> {
  const user = auth.currentUser
  if (!user || user.uid !== uid) return Promise.resolve(false)
  if (adminCheck?.uid !== uid) {
    adminCheck = {
      uid,
      result: user
        .getIdTokenResult(true)
        .then((t) => t.claims.admin === true)
        .catch(() => false),
    }
  }
  return adminCheck.result
}

export async function listPendingPhotos(): Promise<PendingPhoto[]> {
  const { data } = await httpsCallable<object, { photos: PendingPhoto[] }>(functions, 'listPendingPhotos')({})
  return data.photos
}

export async function reviewPendingPhoto(photo: PendingPhoto, action: 'approve' | 'reject'): Promise<void> {
  await httpsCallable(functions, 'reviewPendingPhoto')({ targetUid: photo.uid, photoUrl: photo.url, action })
}

// Why moderation held it back, in a few words.
export function flagReason(reason: unknown): string {
  if (typeof reason !== 'object' || reason === null) return '—'
  const r = reason as Record<string, unknown>
  if (r.noFace === true) return 'No face (first photo)'
  // The automatic check failed (details are in the function logs, not here).
  if (typeof r.error === 'string') return "Automatic check didn't finish — review it yourself"
  const scores = (['nudity', 'gore', 'offensive'] as const)
    .filter((k) => typeof r[k] === 'number' && (r[k] as number) > 0)
    .map((k) => `${k} ${Math.round((r[k] as number) * 100)}%`)
  return scores.length > 0 ? scores.join(' · ') : '—'
}
