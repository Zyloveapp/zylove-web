// Mirrors src/services/fieldLimits.ts in the web app — keep in sync.
//
// F-099: religion, politics, drinking, attraction and dealbreakers (owner-only
// in users/{uid}/private/matching) and the intent (private/profile) change at
// most once every 30 days each. Dealbreaker probing — your own
// different_religion / heavy_drinker dealbreaker, then cycling your own value —
// re-scores every pair, so unlimited edits read other people's private values
// back. The rules enforce it (firestore.rules, limitedChangeOk) with a
// timestamp per field in fieldChangedAt on the same doc:
//
// - The first value is free and starts no clock (a field that was never set:
//   absent, null, '' or an empty list).
// - After that every change stamps fieldChangedAt.<field> with the server
//   time, and is refused while the last stamp is under 30 days old. Clearing
//   counts as a change, so clear-then-set can't skip the wait.
// - Saving the same value again isn't a change; lists are compared as sets
//   and saved sorted, so a reorder isn't one either.

export const FIELD_CHANGE_DAYS = 30
export const FIELD_CHANGE_MS = FIELD_CHANGE_DAYS * 24 * 60 * 60 * 1000

export const LIMITED_MATCHING_FIELDS = ['religion', 'politicalView', 'drinkingHabit', 'attractedTo', 'dealbreakers'] as const
export const LIMITED_PROFILE_FIELDS = ['intent'] as const
export type LimitedField = (typeof LIMITED_MATCHING_FIELDS)[number] | (typeof LIMITED_PROFILE_FIELDS)[number]

// How a refused change names the field ("You can change <this> again on …").
export const LIMITED_FIELD_PHRASES: Record<LimitedField, string> = {
  religion: 'your religion',
  politicalView: 'your political views',
  drinkingHabit: 'your drinking',
  attractedTo: "who you're attracted to",
  dealbreakers: 'your dealbreakers',
  intent: "what you're here for",
}

// Never set: absent, null, '' or an empty list.
export function isUnset(v: unknown): boolean {
  return v === undefined || v === null || ((typeof v === 'string' || Array.isArray(v)) && v.length === 0)
}

// The value as saved: lists sorted without repeats, unset as null.
export function normaliseValue(v: unknown): unknown {
  if (isUnset(v)) return null
  if (Array.isArray(v)) return [...new Set(v.map(String))].sort()
  return v
}

// Same value once normalised (a reordered list is the same value).
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normaliseValue(a)) === JSON.stringify(normaliseValue(b))
}

// Whether changing a field stamps it: always, except the first value.
export function needsStamp(current: unknown, stampMs: number | null): boolean {
  return !(isUnset(current) && stampMs === null)
}

// When the field can change again (ms), or null if it can change now.
export function lockedUntil(stampMs: number | null, now: number): number | null {
  if (stampMs === null) return null
  const at = stampMs + FIELD_CHANGE_MS
  return now < at ? at : null
}

// "November 8", in the viewer's time zone.
export function formatUnlockDate(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', ...(timeZone && { timeZone }) })
}

// Shown next to a locked field.
export function unlockMessage(ms: number, timeZone?: string): string {
  return `You can change this again on ${formatUnlockDate(ms, timeZone)}.`
}

// Shown when a save is refused: one sentence per locked field.
export function lockedMessage(locked: { field: LimitedField; until: number }[], timeZone?: string): string {
  return locked.map(({ field, until }) => `You can change ${LIMITED_FIELD_PHRASES[field]} again on ${formatUnlockDate(until, timeZone)}.`).join(' ')
}
