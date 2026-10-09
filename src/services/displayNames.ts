import { Timestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from './firebase'

// Two public names: displayName (Spark) and playDisplayName (Play). Each can change once every 30 days, tracked by
// displayNameUpdatedAt / playDisplayNameUpdatedAt. The private legalName is
// never shown.

export const MAX_PLAY_NAME = 20
const NAME_CHANGE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000

function millis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis()
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// When the name can next change, or null if it can change now.
export function nextNameChange(updatedAt: unknown, now = Date.now()): Date | null {
  const last = millis(updatedAt)
  if (last === null || now - last >= NAME_CHANGE_INTERVAL_MS) return null
  return new Date(last + NAME_CHANGE_INTERVAL_MS)
}

// F-079: what a new public name may be — the rules (a first name) and
// updateDisplayName (a change) take the same: 2–20 characters, letters (any
// language), numbers, and single spaces, hyphens or apostrophes between them.
const NAME_PATTERN = /^[\p{L}\p{M}\p{N}]+(?:[ '’-][\p{L}\p{M}\p{N}]+)*$/u
export const NAME_RULE = 'Names are 2–20 characters: letters, numbers, spaces, hyphens and apostrophes.'
export function publicNameOk(name: string): boolean {
  const n = name.trim()
  return n.length >= 2 && n.length <= 20 && NAME_PATTERN.test(n)
}

export function formatNameChangeDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

// The name a Play profile shows: its Play name, or '' when it has none —
// never the Spark displayName (the modes stay sealed; callers show
// 'Someone'). Pass the Play profile first — since Stage 2 its playDisplayName
// is the enforced one; an older root copy counts only as a fallback.
export function playNameOf(...sources: (object | null | undefined)[]): string {
  for (const s of sources) {
    const name = (s as { playDisplayName?: unknown } | null | undefined)?.playDisplayName
    if (typeof name === 'string' && name.trim()) return name.trim()
  }
  return ''
}

// A name change after the first one goes through the updateDisplayName
// callable, which enforces the 30-day limit (the rules stop direct writes).
// Resolves with an error message to show, or null on success.
export async function changeDisplayName(mode: 'spark' | 'play', displayName: string): Promise<string | null> {
  try {
    await httpsCallable(functions, 'updateDisplayName')({ mode, displayName })
    return null
  } catch (err) {
    if (err instanceof FirebaseError && err.message && err.code !== 'functions/internal') return err.message
    return "Couldn't change your name right now. Try again."
  }
}
