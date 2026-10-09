import { createHash } from 'node:crypto'
import { logger } from 'firebase-functions'
import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { takeRateLimit } from './rateLimits'

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
// F-124 (M13): one account's share of it — 30 uploads a day each used to
// spend the project's monthly budget in about 32 account-days, turning the
// stolen-photo check off for everyone.
export const VISION_PER_ACCOUNT = 6
export const VISION_PER_ACCOUNT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
// F-124: Sightengine (6 models a photo) had no project-wide limit. Past
// this many photos a day, an upload is held for a person to review — the
// fail-closed path — rather than published unchecked.
export const SIGHTENGINE_DAILY_BUDGET = 2000
const db = () => getFirestore()
const keyOf = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 16)

export interface PhotoSignal {
  path: string
  ai: number | null
  deepfake: number | null
  web: { full: number; pages: number; sample: string[] } | null
}

// A photo's moderation result (published / pending) can land after another
// photo's check recounts, so a photo checked this recently always counts.
export const RECENT_CHECK_MS = 15 * 60 * 1000

// The account's counts over the photos it still has (or just uploaded).
export function photoFlagCounts(photos: (PhotoSignal & { at?: number })[], current: Set<string>, now = Date.now()): { ai: number; stolen: number } {
  const live = photos.filter((p) => current.has(p.path) || (typeof p.at === 'number' && now - p.at < RECENT_CHECK_MS))
  return { ai: live.filter(isAiPhoto).length, stolen: live.filter(isStolenPhoto).length }
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
  const { ai, stolen } = photoFlagCounts(Object.values((saved.data()?.photos ?? {}) as Record<string, PhotoSignal & { at?: number }>), current)
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

// One Sightengine check from today's budget, or false when it's spent.
export async function takeSightengineBudget(): Promise<boolean> {
  const ref = db().doc(`rateLimits/_sightengine_${new Date().toISOString().slice(0, 10)}`)
  return db()
    .runTransaction(async (tx) => {
      const n = ((await tx.get(ref)).get('count') as number | undefined) ?? 0
      if (n >= SIGHTENGINE_DAILY_BUDGET) return false
      tx.set(ref, { count: n + 1 }, { merge: true })
      return true
    })
    .catch(() => true)
}

// Where else this image appears on the web (null: not checked — this
// account's share or the month's budget spent, or the call failed; a
// failure never blocks anything).
export async function webMatches(bucket: string, path: string, uid: string): Promise<PhotoSignal['web']> {
  const ownShare = await takeRateLimit(uid, 'visionWeb', { max: VISION_PER_ACCOUNT, windowMs: VISION_PER_ACCOUNT_WINDOW_MS }).then(() => true, () => false)
  if (!ownShare) {
    logger.info('webMatches: this account used its share — not checked')
    return null
  }
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
