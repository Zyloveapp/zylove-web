import { createHash } from 'node:crypto'
import { logger } from 'firebase-functions'
import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'

// T&S Phase 2 — AI-generated and stolen photos. FLAG FOR REVIEW ONLY: these
// checks never reject or hide a photo (moderation in onPhotoUpload decides
// that, as before); they add a reason to the account's risk score.
//   photoSignals/{uid} (server-only): { photos: { [key]: { path, ai, deepfake,
//     web: { full, pages, sample[] } | null, at } } } — deleted with the account
//   behaviorSignals/{uid}.photoFlags { ai, stolen, at } — counts over the
//     photos the account still has
//
// AI: Sightengine's genai + deepfake models, in the same call as moderation.
// Stolen: Google Cloud Vision Web Detection (finds the same image on public
// web pages), kept inside the free tier by a monthly budget.

export const AI_FLAG_AT = 0.9
export const DEEPFAKE_FLAG_AT = 0.8
export const VISION_MONTHLY_BUDGET = 950 // Web Detection: first 1,000 a month are free
const db = () => getFirestore()
const keyOf = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 16)

export interface PhotoSignal {
  path: string
  ai: number | null
  deepfake: number | null
  web: { full: number; pages: number; sample: string[] } | null
}

export const isAiPhoto = (p: Pick<PhotoSignal, 'ai' | 'deepfake'>) => (p.ai ?? 0) >= AI_FLAG_AT || (p.deepfake ?? 0) >= DEEPFAKE_FLAG_AT
export const isStolenPhoto = (p: Pick<PhotoSignal, 'web'>) => !!p.web && (p.web.full > 0 || p.web.pages > 0)

// Saves one photo's results and refreshes the account's counts, over the
// photos it still has (published or waiting for review, either mode).
export async function recordPhotoSignal(uid: string, signal: PhotoSignal): Promise<void> {
  const ref = db().doc(`photoSignals/${uid}`)
  await ref.set({ photos: { [keyOf(signal.path)]: { ...signal, at: Date.now() } } }, { merge: true })
  const [root, play, account, saved] = await Promise.all([
    db().doc(`users/${uid}`).get(),
    db().doc(`users/${uid}/playProfile/data`).get(),
    db().doc(`users/${uid}/private/account`).get(),
    ref.get(),
  ])
  const current = new Set<string>([
    ...((root.data()?.photoURLs ?? []) as string[]),
    ...((play.data()?.photoURLs ?? []) as string[]),
    ...((account.data()?.pendingPhotoURLs ?? []) as DocumentData[]).map((p) => String(p?.url ?? '')),
    signal.path,
  ])
  const photos = Object.values((saved.data()?.photos ?? {}) as Record<string, PhotoSignal>).filter((p) => current.has(p.path))
  const ai = photos.filter(isAiPhoto).length
  const stolen = photos.filter(isStolenPhoto).length
  await db()
    .doc(`behaviorSignals/${uid}`)
    .set({ photoFlags: ai || stolen ? { ai, stolen, at: Date.now() } : FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
}

// The function's own service-account token (Cloud Run metadata server).
async function accessToken(): Promise<string> {
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' },
  })
  if (!r.ok) throw new Error(`metadata_${r.status}`)
  return ((await r.json()) as { access_token: string }).access_token
}

// One unit of this month's budget, or false when it's spent.
async function takeVisionBudget(): Promise<boolean> {
  const ref = db().doc(`rateLimits/_visionWeb_${new Date().toISOString().slice(0, 7)}`)
  return db()
    .runTransaction(async (tx) => {
      const n = ((await tx.get(ref)).get('count') as number | undefined) ?? 0
      if (n >= VISION_MONTHLY_BUDGET) return false
      tx.set(ref, { count: n + 1 }, { merge: true })
      return true
    })
    .catch(() => false)
}

// Where else this image appears on the web (null: not checked — budget
// spent or the call failed; a failure never blocks anything).
export async function webMatches(bucket: string, path: string): Promise<PhotoSignal['web']> {
  if (!(await takeVisionBudget())) {
    logger.warn('webMatches: monthly Vision budget reached — not checked')
    return null
  }
  try {
    const res = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ image: { source: { imageUri: `gs://${bucket}/${path}` } }, features: [{ type: 'WEB_DETECTION', maxResults: 10 }] }],
      }),
    })
    if (!res.ok) throw new Error(`vision_http_${res.status}`)
    const web = ((await res.json()) as { responses?: { webDetection?: DocumentData; error?: { message?: string } }[] }).responses?.[0]
    if (web?.error) throw new Error(web.error.message ?? 'vision_error')
    const full = ((web?.webDetection?.fullMatchingImages ?? []) as unknown[]).length
    const pages = ((web?.webDetection?.pagesWithMatchingImages ?? []) as DocumentData[]).filter((p) => (p.fullMatchingImages ?? []).length > 0)
    return { full, pages: pages.length, sample: pages.slice(0, 3).map((p) => String(p.url ?? '')).filter(Boolean) }
  } catch (err) {
    logger.warn('webMatches: not checked', { message: err instanceof Error ? err.message : String(err) })
    return null
  }
}
