// H2 (fresh-eyes review): one reading of a stored gender, used by everything
// it decides — identity Elite and the founding circle (identity.ts), Explore
// (explore.ts), scoring (legacy/scoring.ts, legacy/tier1/scorePair.ts) and
// the public line (genderLine.ts). Each used to normalise its own way: "Woman"
// or "cis woman" counted as a woman for lifetime Elite and a women's founder
// spot while Explore, which was case-sensitive, matched the account as a man.
// Pure: no Firestore, no Functions runtime.
//
// The keys are the app's (src/types/profile.ts GenderIdentity); the rules
// accept only these in private/matching.genderIdentity (or null), and
// scripts/migrate-gender-keys.mjs rewrites older stored forms to them.

export const GENDER_KEYS = ['man', 'woman', 'trans_man', 'trans_woman', 'nonbinary', 'genderfluid', 'agender', 'self_describe'] as const
export type GenderKey = (typeof GENDER_KEYS)[number]

const KEYS = new Set<string>(GENDER_KEYS)

// Older stored forms (after lowercasing, trimming and spaces / hyphens →
// "_"): mobile labels ("Trans Woman", "Non-binary"), the aliases the server
// used to accept, and mobile's options the web never had — those are
// off-map, so they're matched by matchableAs, as self_describe is.
const ALIASES: Record<string, GenderKey> = {
  non_binary: 'nonbinary',
  cis_woman: 'woman',
  cisgender_woman: 'woman',
  cis_man: 'man',
  cisgender_man: 'man',
  transwoman: 'trans_woman',
  transgender_woman: 'trans_woman',
  transman: 'trans_man',
  transgender_man: 'trans_man',
  self_described: 'self_describe',
  // Mobile only (its Spark list and its Play multi-select).
  prefer_not_to_say: 'self_describe',
  genderqueer: 'self_describe',
  two_spirit: 'self_describe',
  intersex: 'self_describe',
}

// The key a stored value means, or null (unset, or not a gender we know).
// A list (older mobile Play builds) counts by its first entry, as every
// reader did.
export function normalizeGender(v: unknown): GenderKey | null {
  const raw = Array.isArray(v) ? v[0] : v
  if (typeof raw !== 'string') return null
  const k = raw.normalize('NFKC').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (KEYS.has(k)) return k as GenderKey
  return ALIASES[k] ?? null
}

export const isGenderKey = (v: unknown): v is GenderKey => typeof v === 'string' && KEYS.has(v)
