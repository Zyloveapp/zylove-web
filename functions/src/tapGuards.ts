// F-090: checks shared by onTap and recordSwipe. Pure, so unit-testable.

// What a uid looks like (Firebase Auth uids, seed-/zbot- ids).
export const UID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function isUidShape(v: unknown): v is string {
  return typeof v === 'string' && UID_RE.test(v)
}

// The triggered dealbreakers a tapper may see: only their OWN. The scoring
// engine lists dealbreakers from both sides (calculateSparkScore), but the
// other person's dealbreakers are their private matching preferences
// (private/matching, owner-only) — showing "ruled out: smokers" because THEY
// ruled it out would reveal them to anyone with Spark+. The score itself still
// carries the cap either way; the tapper just sees which of their own
// dealbreakers the profile trips.
export function ownDealbreakers(triggered: unknown, mine: unknown): string[] {
  if (!Array.isArray(triggered) || !Array.isArray(mine)) return []
  const own = new Set(mine.filter((d): d is string => typeof d === 'string'))
  return triggered.filter((d): d is string => typeof d === 'string' && own.has(d))
}
