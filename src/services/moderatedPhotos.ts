import { doc, onSnapshot } from 'firebase/firestore'
import { ref, uploadBytes } from 'firebase/storage'
import { myPlayId } from './playId'
import { db, storage } from './firebase'

// Profile photos go through the existing onPhotoUpload Cloud Function
// (Sightengine), which watches photos/{uid}/spark|play/. It writes its verdict
// to the profile doc — users/{uid} for Spark, users/{uid}/playProfile/data for
// Play — as the photo's Storage path in photoURLs (passed), or flags it with
// an entry in pendingPhotoURLs on the owner-only users/{uid}/private/account
// (both modes). Clients never publish photos themselves. The target doc must
// already exist: the function only updates it.

export type ModerationOutcome = 'approved' | 'pending' | 'timeout' | 'failed' | 'unsupported'

export interface ModeratedPhoto {
  outcome: ModerationOutcome
  url: string | null // the published photo (its Storage path) when approved
}

const VERDICT_TIMEOUT_MS = 30_000

export const MODERATION_MESSAGES: Record<Exclude<ModerationOutcome, 'approved'>, string> = {
  pending: 'Photo is under review. It will appear once approved.',
  timeout: 'Photo upload is taking longer than expected. Try again.',
  failed: "Couldn't upload that photo. Try again.",
  // Stage B (F-052): a photo this browser can't re-encode would go up with
  // its metadata — GPS location included.
  unsupported: "This browser can't prepare that photo (often an iPhone HEIC photo). Choose a JPEG or PNG, or save it as JPEG first.",
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// Waits (live, up to 30s) for the function's verdict on one file, matched by
// its file name (older entries hold a URL rather than the path).
function awaitVerdict(uid: string, mode: 'spark' | 'play', fileName: string): Promise<ModeratedPhoto> {
  const target = mode === 'play' ? doc(db, `users/${uid}/playProfile/data`) : doc(db, 'users', uid)
  const pendingDoc = doc(db, 'users', uid, 'private', 'account')
  return new Promise((resolve) => {
    let settled = false
    const unsubscribes: (() => void)[] = []
    const finish = (result: ModeratedPhoto) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribes.forEach((off) => off())
      resolve(result)
    }
    const timer = setTimeout(() => finish({ outcome: 'timeout', url: null }), VERDICT_TIMEOUT_MS)
    const watchPending = (data: Record<string, unknown>) => {
      const pending: unknown = data.pendingPhotoURLs
      if (Array.isArray(pending) && pending.some((p) => typeof p?.url === 'string' && p.url.includes(fileName))) {
        finish({ outcome: 'pending', url: null })
      }
    }
    unsubscribes.push(
      onSnapshot(
        target,
        (snap) => {
          const data = snap.data() ?? {}
          const approved = strings(data.photoURLs).find((u) => u.includes(fileName))
          if (approved) return finish({ outcome: 'approved', url: approved })
        },
        () => finish({ outcome: 'timeout', url: null }),
      ),
    )
    unsubscribes.push(onSnapshot(pendingDoc, (snap) => watchPending(snap.data() ?? {}), () => {}))
  })
}

// Profile photos are re-encoded through a canvas before upload, as chat
// photos are (preparePhoto in photos.ts): longest edge capped, JPEG, and all
// metadata (EXIF, including GPS location) dropped. Transparent areas are
// filled first, since JPEG has no alpha (they'd otherwise turn black).
const MAX_EDGE = 1600
const JPEG_QUALITY = 0.85
const TRANSPARENT_FILL = '#ffffff'

// The resized JPEG, or null when the browser can't decode the file (e.g.
// HEIC outside Safari) — nothing is uploaded then (Stage B): the original
// would carry its metadata, GPS location included.
async function resizeForUpload(file: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return null
    }
    ctx.fillStyle = TRANSPARENT_FILL
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
  } catch {
    return null
  }
}

// Uploads one photo for moderation and waits for the verdict. onUploaded
// runs once the upload itself is done (or has failed), before the verdict.
export async function uploadModeratedPhoto(
  uid: string,
  mode: 'spark' | 'play',
  file: File,
  onUploaded?: () => void,
): Promise<ModeratedPhoto> {
  const resized = await resizeForUpload(file)
  if (!resized) {
    onUploaded?.()
    return { outcome: 'unsupported', url: null }
  }
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jpg`
  // F-062: a Play photo goes under your Play ID (playPhotos/{playId}/…), so
  // its path never carries your uid.
  const playId = mode === 'play' ? await myPlayId(uid) : null
  if (mode === 'play' && !playId) {
    onUploaded?.()
    return { outcome: 'failed', url: null }
  }
  const path = playId ? `playPhotos/${playId}/${fileName}` : `photos/${uid}/${mode}/${fileName}`
  try {
    await uploadBytes(ref(storage, path), resized, { contentType: 'image/jpeg' })
  } catch (err) {
    console.error('Profile photo upload failed:', err)
    onUploaded?.()
    return { outcome: 'failed', url: null }
  }
  onUploaded?.()
  return awaitVerdict(uid, mode, fileName)
}

// Progress for a batch: how many uploads are done. Once uploaded === total
// the photos are only waiting on moderation.
export type PhotoUploadProgress = (uploaded: number, total: number) => void

// Onboarding saves report what they're doing, for the button label.
export type SaveProgress = (message: string) => void

// SaveProgress messages for a photo batch.
export function photoProgress(onProgress?: SaveProgress): PhotoUploadProgress {
  return (uploaded, total) =>
    onProgress?.(
      uploaded < total
        ? `Uploading photos (${Math.min(uploaded + 1, total)} of ${total})…`
        : total === 1
          ? 'Checking your photo…'
          : 'Checking photos…',
    )
}

// Several at once (onboarding). The messages to show for anything that didn't
// pass, one per distinct outcome.
export async function uploadModeratedPhotos(
  uid: string,
  mode: 'spark' | 'play',
  files: File[],
  onProgress?: PhotoUploadProgress,
): Promise<{ results: ModeratedPhoto[]; notices: string[] }> {
  let uploaded = 0
  if (files.length > 0) onProgress?.(0, files.length)
  const results = await Promise.all(
    files.map((f) => uploadModeratedPhoto(uid, mode, f, () => onProgress?.(++uploaded, files.length))),
  )
  const outcomes = new Set(results.map((r) => r.outcome))
  const notices = (['pending', 'timeout', 'failed', 'unsupported'] as const).filter((o) => outcomes.has(o)).map((o) => MODERATION_MESSAGES[o])
  return { results, notices }
}
