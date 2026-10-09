// Dealbreakers saved by older web builds went to users/{uid}/seekingPreferences/
// prefs, which scoring never read — it reads private/matching (userData.ts
// MATCHING_FIELDS). What to do with one account's old list; used by
// scripts/lib/dealbreakers.mjs (scripts/migrate-dealbreakers.mjs), tested in
// test/dealbreakerMove.test.ts.

import { DEALBREAKER_LABELS } from './shared/profile'
import { isUnset, normaliseValue, sameValue } from './shared/fieldLimits'

export type DealbreakerMove =
  // Nothing valid in the old list: it's only removed.
  | { action: 'empty'; dropped: number }
  // Nothing in effect: the old list becomes the private one, as a first value
  // (no fieldChangedAt stamp — it never took effect, so no clock starts).
  | { action: 'copy'; value: string[]; dropped: number }
  // The same list is already in effect.
  | { action: 'identical'; dropped: number }
  // A different list is in effect (or the owner cleared it under the 30-day
  // limit): that one is kept.
  | { action: 'conflict'; stamped: boolean; dropped: number }

const KNOWN = new Set(Object.keys(DEALBREAKER_LABELS))

// The list scoring uses: private/matching's, else (accounts not migrated to
// Stage 3) the public doc's old copy — withPrivateProfile's fallback.
export function dealbreakersInEffect(matching: Record<string, unknown> | undefined, root: Record<string, unknown> | undefined): unknown {
  return matching?.dealbreakers !== undefined ? matching.dealbreakers : root?.dealbreakers
}

// The old list's scoring keys, sorted without repeats (as the app saves
// them), and how many values weren't one (the retired enum, junk).
export function cleanDealbreakers(v: unknown): { value: string[]; dropped: number } {
  if (v === undefined || v === null) return { value: [], dropped: 0 }
  if (!Array.isArray(v)) return { value: [], dropped: 1 }
  const valid = v.filter((x): x is string => typeof x === 'string' && KNOWN.has(x))
  return { value: (normaliseValue(valid) as string[] | null) ?? [], dropped: v.length - valid.length }
}

export function planDealbreakerMove(
  seeking: unknown,
  matching: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined,
): DealbreakerMove {
  const { value, dropped } = cleanDealbreakers(seeking)
  if (value.length === 0) return { action: 'empty', dropped }
  const stamped = (matching?.fieldChangedAt as Record<string, unknown> | undefined)?.dealbreakers != null
  const current = dealbreakersInEffect(matching, root)
  if (isUnset(current)) return stamped ? { action: 'conflict', stamped, dropped } : { action: 'copy', value, dropped }
  return sameValue(current, value) ? { action: 'identical', dropped } : { action: 'conflict', stamped: false, dropped }
}
