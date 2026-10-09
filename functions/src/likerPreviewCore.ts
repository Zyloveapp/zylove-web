import { randomBytes } from 'node:crypto'

// §4.A3 — anonymous likers: the pure parts (no Firestore), unit-tested in
// test/likerPreview.test.ts. The server side is likerPreview.ts.
//
// A like in someone's queue is named to them by an opaque like id (lk_…),
// random and stored on the server-only queue doc — never derived from the
// liker's uid or Play ID, so it can't be tested against a uid someone already
// knows (an unkeyed hash of the uid could be).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const LIKE_ID_RE = /^lk_[A-Za-z0-9]{20}$/

export const isLikeId = (v: unknown): v is string => typeof v === 'string' && LIKE_ID_RE.test(v)

export function newLikeId(): string {
  // Same shape as Play IDs (playIds.ts randomId): 62^20 ≈ 2^119.
  let s = 'lk_'
  for (const b of randomBytes(20)) s += ALPHABET[b % ALPHABET.length]
  return s
}

export type LikeMode = 'spark' | 'play'
export type Plan = 'free' | 'spark_plus' | 'elite'

// What the liked person's client gets for one like: when, which mode, its
// state and the pair's headline score — nothing that names the liker (no uid,
// no Play ID, no profile snapshot) and none of the score's details (F-098:
// the breakdown and dealbreakers stay server-side).
export interface LikeEntry {
  likeId: string
  mode: LikeMode
  likedAt: number
  dismissed: boolean
  isWeeklySpark: boolean
  expiresAt: number | null
  // Null for curated profiles: their seeded likes carry a placeholder.
  compatibilityScore: number | null
  curated: boolean
}

const millis = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const t = v as { toMillis?: () => number } | null
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null
}

// A queue doc (users/{uid}/likeQueue/{key}) → the entry. `key` is the doc id
// (the liker's uid, or Play ID in Play) — used only to tell a curated like.
export function likeEntryOf(likeId: string, key: string, data: Record<string, unknown>): LikeEntry {
  const curated = key.startsWith('zbot-') || data.curated === true
  const score = data.compatibilityScore
  return {
    likeId,
    mode: data.mode === 'play' ? 'play' : 'spark',
    likedAt: millis(data.likedAt) ?? 0,
    dismissed: data.dismissed === true,
    isWeeklySpark: data.isWeeklySpark === true,
    expiresAt: millis(data.expiresAt),
    compatibilityScore: !curated && typeof score === 'number' && score > 0 ? score : null,
    curated,
  }
}

// Still waiting: not passed on, not expired.
export function isLive(e: LikeEntry, raw: Record<string, unknown>, now: number): boolean {
  return !e.dismissed && raw.isExpired !== true && (e.expiresAt === null || e.expiresAt > now)
}

// The liker as the server sees them when the queue is read.
export interface LikerState {
  exists: boolean
  deleted: boolean
  suspended: boolean
  blocked: boolean // either way
  // Play: the liker still has Play access and a public Play profile.
  playOk: boolean
}

// Blocked (either way), suspended, deleted or gone: the like is hidden — not
// listed, not counted, not previewed. A Play like also needs the liker in Play.
export function likeVisible(s: LikerState, mode: LikeMode): boolean {
  if (!s.exists || s.deleted || s.suspended || s.blocked) return false
  return mode !== 'play' || s.playOk
}

// Free: the count only — no list, no preview of a real person. A curated
// profile's like is shown on every plan (no paid feature involves a bot).
export function previewAllowed(plan: Plan, curated: boolean): boolean {
  return curated || plan === 'spark_plus' || plan === 'elite'
}

export interface PreviewPrompt {
  promptId: string
  answer: string
  // Only for a 'dynamic' prompt: its question is the profile's own.
  question?: string
}

// Everything a preview may hold (§4.A3: photo, first name, bio, prompts).
export interface LikerPreview {
  mode: LikeMode
  firstName: string
  photo: string | null
  bio: string
  prompts: PreviewPrompt[]
  curated: boolean
}

const MAX_PROMPTS = 6
const MAX_TEXT = 1000

const text = (v: unknown, max = MAX_TEXT): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export function firstNameOf(name: unknown): string {
  const first = text(name, 200).split(/\s+/)[0] ?? ''
  return first.slice(0, 40) || 'Someone'
}

// Prompt answers as the promptAnswers array (mobile, bots, web) or, in Play,
// the playPromptAnswers { promptId: answer } map (web onboarding).
export function promptsOf(arr: unknown, map: unknown, dynamicPrompt?: unknown): PreviewPrompt[] {
  const out: PreviewPrompt[] = []
  if (Array.isArray(arr)) {
    for (const p of arr) {
      const r = p as Record<string, unknown> | null
      if (r && typeof r.promptId === 'string' && text(r.answer)) out.push({ promptId: r.promptId.slice(0, 80), answer: text(r.answer) })
    }
  } else if (map && typeof map === 'object') {
    for (const [promptId, answer] of Object.entries(map as Record<string, unknown>)) {
      if (text(answer)) out.push({ promptId: promptId.slice(0, 80), answer: text(answer) })
    }
  }
  const q = text(dynamicPrompt, 300)
  return out.slice(0, MAX_PROMPTS).map((p) => (p.promptId === 'dynamic' && q ? { ...p, question: q } : p))
}

// Where the preview's fields come from. Spark: the public root doc. Play:
// the server-kept public Play copy (playProfiles/{playId}) — never the Spark
// profile.
export interface PreviewSource {
  name: unknown
  photoRef: string | null
  bio: unknown
  prompts: PreviewPrompt[]
}

const firstString = (v: unknown): string | null => (Array.isArray(v) && typeof v[0] === 'string' && v[0] ? v[0] : null)

export function sparkSource(root: Record<string, unknown>): PreviewSource {
  return { name: root.displayName, photoRef: firstString(root.photoURLs), bio: root.bio, prompts: promptsOf(root.promptAnswers, null, root.dynamicPrompt) }
}

export function playSource(play: Record<string, unknown>): PreviewSource {
  return {
    name: play.playDisplayName,
    photoRef: firstString(play.photoURLs),
    bio: play.playBio,
    prompts: promptsOf(play.promptAnswers, play.playPromptAnswers),
  }
}

// How a photo reference may go out: a Storage path (photos/{uid}/…,
// playPhotos/{playId}/…) or a Storage URL names the owner, so it's sent as
// the image itself ('inline'); any other https address goes as is, unless it
// contains one of `ids` (the liker's uid or Play ID). Anything else: no photo.
export function photoDelivery(ref: string | null, ids: string[], isStorage: (ref: string) => boolean): 'inline' | 'url' | null {
  if (!ref) return null
  if (isStorage(ref)) return 'inline'
  if (!ref.startsWith('https://')) return null
  return ids.some((id) => id && ref.includes(id)) ? null : 'url'
}

export function buildPreview(mode: LikeMode, curated: boolean, src: PreviewSource, photo: string | null): LikerPreview {
  return { mode, firstName: firstNameOf(src.name), photo, bio: text(src.bio), prompts: src.prompts, curated }
}
