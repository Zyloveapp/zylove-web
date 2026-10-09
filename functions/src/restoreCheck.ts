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
