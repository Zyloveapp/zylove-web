import type { PhotoDraft } from './types'

// In-progress onboarding, kept in localStorage so a reload doesn't wipe it.
// One entry per user and flow. Cleared after a successful save or an
// explicit exit. Storage can be unavailable (private mode, quota): every call
// is wrapped, and the flow just works without it.
//
// New photos (File objects) can't be stored, so they're dropped and the user
// re-adds them; photos that are already uploaded (a refresh's stored URLs)
// are kept.

export type DraftFlow = 'new' | 'refresh' | 'spark-setup' | 'play' | 'play-edit'

const VERSION = 1
// An abandoned draft isn't worth restoring after this long.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

interface Stored<T> {
  v: number
  savedAt: number
  stepIndex: number
  data: T
}

function key(uid: string, flow: DraftFlow): string {
  return `zylove_onboarding_draft_${flow}_${uid}`
}

// Only already-uploaded photos survive a save.
export function storablePhotos(photos: PhotoDraft[]): PhotoDraft[] {
  return photos.filter((p) => p.file === null)
}

export function saveDraft<T>(uid: string, flow: DraftFlow, stepIndex: number, data: T): void {
  try {
    const stored: Stored<T> = { v: VERSION, savedAt: Date.now(), stepIndex, data }
    localStorage.setItem(key(uid, flow), JSON.stringify(stored))
  } catch {
    // Unavailable or full — progress just isn't kept across a reload.
  }
}

export function loadDraft<T>(uid: string, flow: DraftFlow): { stepIndex: number; data: T } | null {
  try {
    const raw = localStorage.getItem(key(uid, flow))
    if (!raw) return null
    const stored = JSON.parse(raw) as Partial<Stored<T>>
    if (
      stored.v !== VERSION ||
      typeof stored.savedAt !== 'number' ||
      Date.now() - stored.savedAt > MAX_AGE_MS ||
      typeof stored.stepIndex !== 'number' ||
      typeof stored.data !== 'object' ||
      stored.data === null
    ) {
      localStorage.removeItem(key(uid, flow))
      return null
    }
    return { stepIndex: stored.stepIndex, data: stored.data }
  } catch {
    return null
  }
}

export function clearDraft(uid: string, flow: DraftFlow): void {
  try {
    localStorage.removeItem(key(uid, flow))
  } catch {
    // ignore
  }
}
