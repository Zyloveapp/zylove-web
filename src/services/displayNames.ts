import { Timestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from './firebase'

// Two public names: displayName (Spark, and Play's fallback) and
// playDisplayName (Play). Each can change once every 30 days, tracked by
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

export function formatNameChangeDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

// The name a Play profile shows: its Play name, else the display name. Pass
// the root user doc first — its playDisplayName is the enforced one (the
// playProfile copy is a client-writable mirror).
export function playNameOf(...sources: ({ playDisplayName?: unknown; displayName?: unknown } | null | undefined)[]): string {
  for (const s of sources) {
    if (typeof s?.playDisplayName === 'string' && s.playDisplayName.trim()) return s.playDisplayName.trim()
  }
  for (const s of sources) {
    if (typeof s?.displayName === 'string' && s.displayName.trim()) return s.displayName.trim()
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
