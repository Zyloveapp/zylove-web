// T&S Phase 5 follow-up: why a photo was held by the scam blocklist, for
// Photo review. The context is stored on the hold when it's created (the
// banned account's records may be gone later); this turns it into the words
// the admin sees. Hashes only — the banned account's images are never kept.

// Recorded on each photoBlocklist entry at ban time.
export interface BanContext {
  name: string // display name before the ban's soft delete ('' if none)
  adminMarkedScam: boolean // the ban dialog's scam/fraud box was ticked
  reports: Record<string, number> // report counts by category
}

// Stored on the held photo's pendingPhotoURLs entry: reason.match.
export interface StoredMatch {
  uid: string
  name: string
  bannedAt: number | null
  adminMarkedScam: boolean
  reports: Record<string, number>
  distance: number
}

// What Photo review shows.
export interface BlocklistMatchView {
  uid: string
  name: string
  bannedAt: number | null
  why: string
  closeness: string
  distance: number
  more: number
  onRecord: boolean
}

// Hamming distance (0–8) in plain words.
export function closeness(distance: number): string {
  if (distance <= 0) return 'Exact copy'
  if (distance <= 4) return 'Very close (edited/re-saved)'
  return 'Similar'
}

// "Banned for a scam or fraud · scam reports: 2 · harassment reports: 1"
export function banWhy(m: Pick<StoredMatch, 'adminMarkedScam' | 'reports'>): string {
  const counts = Object.entries(m.reports ?? {})
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .sort(([a, x], [b, y]) => (a === 'scam' ? -1 : b === 'scam' ? 1 : y - x || a.localeCompare(b)))
    .map(([c, n]) => `${c.replace(/_/g, ' ')} reports: ${n}`)
  const head = m.adminMarkedScam ? 'Banned for a scam or fraud' : 'Banned (scam reports)'
  return [head, ...counts].join(' · ')
}

// Report counts by category, from the account's reports.
export function reportCounts(categoryLists: string[][]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const cats of categoryLists) for (const c of new Set(cats)) out[c] = (out[c] ?? 0) + 1
  return out
}

// The stored hold reason → the view; null when it isn't a blocklist hold
// with context (holds from before this change carry only the distance).
export function matchView(reason: unknown, onRecord: (uid: string) => boolean): BlocklistMatchView | null {
  if (typeof reason !== 'object' || reason === null) return null
  const r = reason as Record<string, unknown>
  if (r.blocklist !== true || typeof r.match !== 'object' || r.match === null) return null
  const m = r.match as Partial<StoredMatch>
  if (typeof m.uid !== 'string' || typeof m.distance !== 'number') return null
  const stored: StoredMatch = {
    uid: m.uid,
    name: typeof m.name === 'string' ? m.name : '',
    bannedAt: typeof m.bannedAt === 'number' ? m.bannedAt : null,
    adminMarkedScam: m.adminMarkedScam === true,
    reports: typeof m.reports === 'object' && m.reports !== null ? m.reports : {},
    distance: m.distance,
  }
  return {
    uid: stored.uid,
    name: stored.name,
    bannedAt: stored.bannedAt,
    why: banWhy(stored),
    closeness: closeness(stored.distance),
    distance: stored.distance,
    more: typeof r.more === 'number' && r.more > 0 ? r.more : 0,
    onRecord: onRecord(stored.uid),
  }
}
