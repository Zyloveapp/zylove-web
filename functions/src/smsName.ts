// F-079: a name as it may appear in a text from Zylove's number. Names go
// into texts verbatim ("You and Sam connected"), so one carrying a link,
// handle or phone number would be texted on our behalf. New names are held
// to updateDisplayName's pattern (and the rules' on first write); this covers
// older names and match snapshots too. Whitespace collapsed, at most 20
// characters, and 'Someone' for anything link- or number-like.

const MAX_SMS_NAME = 20
const LINK_LIKE = /[./:@\\]|www/i

export function smsSafeName(name: unknown): string {
  if (typeof name !== 'string') return 'Someone'
  // Control and invisible characters (zero-width joiners, direction marks) go.
  const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim()
  if (!clean || LINK_LIKE.test(clean)) return 'Someone'
  // A run of 3+ digits, or 5+ in all, reads as a phone number or code.
  if (/\d{3,}/.test(clean) || (clean.match(/\d/g)?.length ?? 0) >= 5) return 'Someone'
  return Array.from(clean).slice(0, MAX_SMS_NAME).join('').trim()
}
