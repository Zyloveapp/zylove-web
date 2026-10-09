// Physical and trait preferences saved by older web builds went to
// users/{uid}/seekingPreferences/prefs, which scoring never read — it reads
// private/matching (userData.ts MATCHING_FIELDS; physicalOrNull in
// legacy/scoring.ts, physicalScore in legacy/tier1/scorePair.ts). What to do
// with one account's old values; used by scripts/lib/seekingPrefs.mjs
// (scripts/migrate-seeking-prefs.mjs), tested in test/seekingMove.test.ts.
//
// Three fields, each decided on its own: the body types, the traits and the
// height range (seekingHeightMinCm + seekingHeightMaxCm, moved as a pair —
// scoring needs both). The web already saved the keys and units scoring
// uses (BODY_TYPE_LABELS / SEEKING_TRAIT_LABELS keys, whole cm), so nothing
// is mapped: values that aren't one are dropped and counted.

import { BODY_TYPE_LABELS, SEEKING_TRAIT_LABELS } from './shared/profile'
import { isUnset, sameValue } from './shared/fieldLimits'

export const SEEKING_MOVE_FIELDS = ['seekingBodyTypes', 'seekingTraits', 'seekingHeight'] as const
export type SeekingMoveField = (typeof SEEKING_MOVE_FIELDS)[number]
// The seekingPreferences keys that move (and that the rules now refuse there).
export const SEEKING_MOVE_KEYS = ['seekingBodyTypes', 'seekingTraits', 'seekingHeightMinCm', 'seekingHeightMaxCm'] as const

export type SeekingFieldMove =
  // Not in the old doc at all.
  | { action: 'absent' }
  // Nothing valid (or "no preference"): it's only removed.
  | { action: 'empty'; dropped: number }
  // Nothing in effect: the old value is copied to private/matching.
  | { action: 'copy'; value: Record<string, unknown>; dropped: number }
  // The same value is already in effect.
  | { action: 'identical'; dropped: number }
  // A different value is in effect: that one is kept.
  | { action: 'conflict'; dropped: number }

// The picker offers 4'0"–7'11" (122–241 cm); anything far outside is junk.
export const HEIGHT_MIN_CM = 100
export const HEIGHT_MAX_CM = 250

// The editor never offers 'prefer_not_to_say' as a body type to look for.
const BODY_TYPES = new Set(Object.keys(BODY_TYPE_LABELS).filter((k) => k !== 'prefer_not_to_say'))
const TRAITS = new Set(Object.keys(SEEKING_TRAIT_LABELS))

// The value scoring uses: private/matching's, else (accounts not migrated to
// Stage 3) the public doc's old copy — withPrivateProfile's fallback.
function inEffect(key: string, matching: Record<string, unknown> | undefined, root: Record<string, unknown> | undefined): unknown {
  return matching?.[key] !== undefined ? matching[key] : root?.[key]
}

// Known keys only, without repeats (order kept), and how many weren't one.
export function cleanKeys(v: unknown, known: Set<string>): { value: string[]; dropped: number } {
  if (v === undefined || v === null) return { value: [], dropped: 0 }
  if (!Array.isArray(v)) return { value: [], dropped: 1 }
  const valid = v.filter((x): x is string => typeof x === 'string' && known.has(x))
  return { value: [...new Set(valid)], dropped: v.length - valid.length }
}

const heightOk = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= HEIGHT_MIN_CM && v <= HEIGHT_MAX_CM

// The range as scoring reads it (both ends set), or null.
export function heightRange(min: unknown, max: unknown): { seekingHeightMinCm: number; seekingHeightMaxCm: number } | null {
  return heightOk(min) && heightOk(max) && min <= max ? { seekingHeightMinCm: Math.round(min), seekingHeightMaxCm: Math.round(max) } : null
}

function listMove(
  key: 'seekingBodyTypes' | 'seekingTraits',
  seeking: Record<string, unknown>,
  matching: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined,
): SeekingFieldMove {
  if (seeking[key] === undefined) return { action: 'absent' }
  const { value, dropped } = cleanKeys(seeking[key], key === 'seekingBodyTypes' ? BODY_TYPES : TRAITS)
  if (value.length === 0) return { action: 'empty', dropped }
  const current = inEffect(key, matching, root)
  if (isUnset(current)) return { action: 'copy', value: { [key]: value }, dropped }
  return sameValue(current, value) ? { action: 'identical', dropped } : { action: 'conflict', dropped }
}

function heightMove(
  seeking: Record<string, unknown>,
  matching: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined,
): SeekingFieldMove {
  const { seekingHeightMinCm: min, seekingHeightMaxCm: max } = seeking
  if (min === undefined && max === undefined) return { action: 'absent' }
  // "Doesn't matter" ticked: a leftover range isn't a preference.
  if (seeking.seekingHeightNoPreference === true) return { action: 'empty', dropped: 0 }
  const range = heightRange(min, max)
  if (!range) return { action: 'empty', dropped: 1 }
  // Scoring uses a range only with both ends; anything less is none.
  const current = heightRange(inEffect('seekingHeightMinCm', matching, root), inEffect('seekingHeightMaxCm', matching, root))
  if (!current) return { action: 'copy', value: range, dropped: 0 }
  return sameValue([current.seekingHeightMinCm, current.seekingHeightMaxCm], [range.seekingHeightMinCm, range.seekingHeightMaxCm])
    ? { action: 'identical', dropped: 0 }
    : { action: 'conflict', dropped: 0 }
}

export function planSeekingMove(
  seeking: Record<string, unknown> | undefined,
  matching: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined,
): Record<SeekingMoveField, SeekingFieldMove> {
  const s = seeking ?? {}
  return {
    seekingBodyTypes: listMove('seekingBodyTypes', s, matching, root),
    seekingTraits: listMove('seekingTraits', s, matching, root),
    seekingHeight: heightMove(s, matching, root),
  }
}
