import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'

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

export async function isAdmin(uid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid))
  return snap.data()?.isAdmin === true
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
  if (typeof r.error === 'string') return `Moderation error: ${r.error}`
  const scores = (['nudity', 'gore', 'offensive'] as const)
    .filter((k) => typeof r[k] === 'number' && (r[k] as number) > 0)
    .map((k) => `${k} ${Math.round((r[k] as number) * 100)}%`)
  return scores.length > 0 ? scores.join(' · ') : '—'
}
