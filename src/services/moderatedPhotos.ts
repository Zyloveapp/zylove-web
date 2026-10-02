import { doc, onSnapshot } from 'firebase/firestore'
import { ref, uploadBytes } from 'firebase/storage'
import { db, storage } from './firebase'

// Profile photos go through the existing onPhotoUpload Cloud Function
// (Sightengine), which watches photos/{uid}/spark|play/. It writes its verdict
// to the profile doc — users/{uid} for Spark, users/{uid}/playProfile/data for
// Play — as a signed URL in photoURLs (passed) or an entry in pendingPhotoURLs
// (flagged). Clients never publish photo URLs themselves. The target doc must
// already exist: the function only updates it.

export type ModerationOutcome = 'approved' | 'pending' | 'timeout' | 'failed'

export interface ModeratedPhoto {
  outcome: ModerationOutcome
  url: string | null // the published URL when approved
}

const VERDICT_TIMEOUT_MS = 30_000

export const MODERATION_MESSAGES: Record<Exclude<ModerationOutcome, 'approved'>, string> = {
  pending: 'Photo is under review. It will appear once approved.',
  timeout: 'Photo upload is taking longer than expected. Try again.',
  failed: "Couldn't upload that photo. Try again.",
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// Waits (live, up to 30s) for the function's verdict on one file. Its URL is a
// signed URL, not the client's download URL, so it's matched by file name.
function awaitVerdict(uid: string, mode: 'spark' | 'play', fileName: string): Promise<ModeratedPhoto> {
  const target = mode === 'play' ? doc(db, `users/${uid}/playProfile/data`) : doc(db, 'users', uid)
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: ModeratedPhoto) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(result)
    }
    const timer = setTimeout(() => finish({ outcome: 'timeout', url: null }), VERDICT_TIMEOUT_MS)
    const unsubscribe = onSnapshot(
      target,
      (snap) => {
        const data = snap.data() ?? {}
        const approved = strings(data.photoURLs).find((u) => u.includes(fileName))
        if (approved) return finish({ outcome: 'approved', url: approved })
        const pending: unknown = data.pendingPhotoURLs
        if (Array.isArray(pending) && pending.some((p) => typeof p?.url === 'string' && p.url.includes(fileName))) {
          finish({ outcome: 'pending', url: null })
        }
      },
      () => finish({ outcome: 'timeout', url: null }),
    )
  })
}

// Uploads one photo for moderation and waits for the verdict.
export async function uploadModeratedPhoto(uid: string, mode: 'spark' | 'play', file: File): Promise<ModeratedPhoto> {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'jpg'
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`
  try {
    await uploadBytes(ref(storage, `photos/${uid}/${mode}/${fileName}`), file, { contentType: file.type })
  } catch {
    return { outcome: 'failed', url: null }
  }
  return awaitVerdict(uid, mode, fileName)
}

// Several at once (onboarding). The messages to show for anything that didn't
// pass, one per distinct outcome.
export async function uploadModeratedPhotos(
  uid: string,
  mode: 'spark' | 'play',
  files: File[],
): Promise<{ results: ModeratedPhoto[]; notices: string[] }> {
  const results = await Promise.all(files.map((f) => uploadModeratedPhoto(uid, mode, f)))
  const outcomes = new Set(results.map((r) => r.outcome))
  const notices = (['pending', 'timeout', 'failed'] as const).filter((o) => outcomes.has(o)).map((o) => MODERATION_MESSAGES[o])
  return { results, notices }
}
