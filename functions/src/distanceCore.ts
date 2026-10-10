// Who may get a distance to whom (getDistances), pure.
//
// F-117 (M6): only people the caller has a live reason to see now — their
// current Explore deck, a live match, or (paid plans) someone who liked them.
// Not everyone they ever swiped on (that list never shrank, so a distance
// stayed answerable for good after an unmatch), and not a profile its owner
// hid or paused unless the two have a live match.
// F-118 (M7): free plans get no distance for likers — they only see a count,
// so a distance would say who liked them.

export interface DistanceReason {
  inDeck: boolean
  liveMatch: boolean
  liker: boolean
}

export function distanceAllowed(r: DistanceReason, opts: { callerPaid: boolean; targetHidden: boolean }): boolean {
  if (r.liveMatch) return true
  if (opts.targetHidden) return false
  return r.inDeck || (r.liker && opts.callerPaid)
}

// A match still counts as live: not blocked, not unmatched, not a chat kept
// only for a report.
export function matchIsLive(m: Record<string, unknown>): boolean {
  return m.isBlocked !== true && m.unmatchedAt == null && m.preservedFor == null
}

export const isHiddenVisibility = (v: unknown): boolean => v === 'paused' || v === 'hidden'
