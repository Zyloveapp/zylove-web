// §4.A2: the one line about gender other people see, built server-side.
//
// genderIdentity, genderSelfDescribe and pronouns live in the owner-only
// users/{uid}/private/matching (with the "Don't show on my profile" and
// "Show my gender" choices). The public users/{uid} doc carries only
// genderLine (server-only), written by identityGuardOnMatching and the
// migration (scripts/migrate-a2-gender.mjs) from this function — so the two
// always agree. Pure: no Firestore, no Functions runtime.
//
//   hidden (genderHidden)                → '' (nothing at all)
//   man / woman                          → pronouns only, unless showGender
//   trans woman, non-binary, agender…    → the label, then pronouns
//   self-describe                        → their words (sanitised), then pronouns
//   unknown or garbage                   → pronouns only
//
// e.g. "Trans woman · she/her", "Non-binary", "she/her", "Man · he/him".
// No category is singled out for filtering anywhere (Matthew's decision):
// this is display only.

export const GENDER_LINE_LABELS: Record<string, string> = {
  man: 'Man',
  woman: 'Woman',
  nonbinary: 'Non-binary',
  trans_man: 'Trans man',
  trans_woman: 'Trans woman',
  genderfluid: 'Genderfluid',
  agender: 'Agender',
}

// Shown only when the owner chose to (showGender): implied by most profiles.
const IMPLIED = new Set(['man', 'woman'])

// The input limits (onboarding and edit profile) and the rules' type checks.
export const MAX_SELF_DESCRIBE = 40
export const MAX_PRONOUNS = 40

export interface GenderLineInput {
  genderIdentity?: unknown
  genderSelfDescribe?: unknown
  pronouns?: unknown
  genderHidden?: unknown
  showGender?: unknown
}

// The stored key: a string on the web, an array from mobile Play; older
// mobile builds stored labels ("Trans Woman", "non-binary").
export function genderKey(v: unknown): string | null {
  const raw = Array.isArray(v) ? v[0] : v
  if (typeof raw !== 'string') return null
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!k) return null
  return k === 'non_binary' ? 'nonbinary' : k === 'self_described' ? 'self_describe' : k
}

// Free text that goes on the public doc: letters (any language) and a few
// joining marks only — no digits (phone numbers), no dots, colons or @
// (links, handles), no "·" (it would fake a second part), no control or
// invisible characters. Whitespace collapsed; at most `max` characters.
function publicText(v: unknown, max: number, allowed: RegExp): string {
  if (typeof v !== 'string') return ''
  const kept = Array.from(v.normalize('NFC'))
    .map((ch) => (/\s/u.test(ch) ? ' ' : allowed.test(ch) ? ch : ''))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
  return Array.from(kept).slice(0, max).join('').trim()
}

const SELF_DESCRIBE_CHARS = /^[\p{L}\p{M}'’\-/&+(),]$/u
const PRONOUN_CHARS = /^[\p{L}\p{M}'’\-/,]$/u

export const cleanSelfDescribe = (v: unknown): string => publicText(v, MAX_SELF_DESCRIBE, SELF_DESCRIBE_CHARS)
export const cleanPronouns = (v: unknown): string => publicText(v, MAX_PRONOUNS, PRONOUN_CHARS)

export function buildGenderLine(m: GenderLineInput | null | undefined): string {
  if (!m || m.genderHidden === true) return ''
  const key = genderKey(m.genderIdentity)
  let gender = ''
  if (key === 'self_describe') gender = cleanSelfDescribe(m.genderSelfDescribe)
  else if (key && GENDER_LINE_LABELS[key] && (!IMPLIED.has(key) || m.showGender === true)) gender = GENDER_LINE_LABELS[key]
  return [gender, cleanPronouns(m.pronouns)].filter(Boolean).join(' · ')
}
