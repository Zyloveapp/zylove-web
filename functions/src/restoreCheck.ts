// F-086: restoring a deleted account within 90 days asks for the old
// account's birthday (typed, never shown), because the phone number may now
// belong to someone else. Pure, so it's unit-tested (test/restoreCheck.test.ts).

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

// A real calendar date as YYYY-MM-DD, or null.
export function isoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = ISO_DATE.exec(raw.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

// The recovery record's birthday as YYYY-MM-DD: the ISO string onboarding
// writes (a longer ISO timestamp is cut to its date), or an older
// Timestamp-like value, read as a UTC date. Null when there's none.
export function storedBirthday(stored: unknown): string | null {
  if (typeof stored === 'string') return isoDate(stored.trim().slice(0, 10))
  if (stored && typeof (stored as { toDate?: unknown }).toDate === 'function') {
    const d = (stored as { toDate: () => Date }).toDate()
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }
  return null
}

// True only when the typed birthday is a real date equal to the record's.
// A record without a birthday never matches (support restores those).
export function restoreBirthdayMatches(typed: unknown, stored: unknown): boolean {
  const want = storedBirthday(stored)
  const got = isoDate(typed)
  return want !== null && got !== null && want === got
}

// ─── H6: what follows a restored account ─────────────────────────────────────
// A restore gives the account a new uid (the old Auth user is gone). Blocks
// are keyed by uid — users/{a}/blockedUsers/{b}, on both sides, recording who
// placed it (blockedBy) — so without this every block against (or by) the
// account stopped applying once it was restored.

export interface BlockEntry {
  // users/{owner}/blockedUsers/{other}
  owner: string
  other: string
  data: Record<string, unknown>
}

// Every blockedUsers doc naming the old uid (its own list, and other people's
// entries for it), re-keyed to the new uid: the docs to write and the ones to
// remove. Each side keeps its own doc's fields where it has one (a block's two
// docs normally match); a side with none gets the other's. Pure.
export function rekeyBlocks(
  oldUid: string,
  newUid: string,
  entries: BlockEntry[],
): { set: { path: string; data: Record<string, unknown> }[]; remove: string[]; others: string[] } {
  const swap = (v: unknown) => (v === oldUid ? newUid : v)
  const sets = new Map<string, Record<string, unknown>>()
  const own = new Set<string>()
  const remove = new Set<string>()
  const others = new Set<string>()
  const put = (owner: string, other: string, data: Record<string, unknown>, direct: boolean) => {
    const path = `users/${owner}/blockedUsers/${other}`
    if (own.has(path)) return
    if (direct) own.add(path)
    else if (sets.has(path)) return
    const next: Record<string, unknown> = { ...data, uid: other }
    if ('blockedBy' in data) next.blockedBy = swap(data.blockedBy)
    sets.set(path, next)
  }
  for (const e of entries) {
    const other = e.owner === oldUid ? e.other : e.other === oldUid ? e.owner : null
    if (other === null || other === oldUid || other === newUid) continue
    others.add(other)
    remove.add(`users/${oldUid}/blockedUsers/${other}`)
    remove.add(`users/${other}/blockedUsers/${oldUid}`)
    const mine = e.owner === oldUid
    put(mine ? newUid : other, mine ? other : newUid, e.data, true)
    put(mine ? other : newUid, mine ? newUid : other, e.data, false)
  }
  return { set: [...sets].map(([path, data]) => ({ path, data })), remove: [...remove], others: [...others] }
}

// A report still waiting for the team (reports.ts: anything not actioned or
// cleared). H6: an account reported and not yet reviewed isn't restored —
// deleting and restoring would leave the reports on a uid nobody uses.
export const reportPending = (r: Record<string, unknown>): boolean => r.status !== 'actioned' && r.status !== 'cleared'
