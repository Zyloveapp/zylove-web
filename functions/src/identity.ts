// How someone is matched and shown to others: their gender category, from
// their identity — or, for identities that don't map to one (self_describe,
// agender, genderfluid…), from matchableAs, which they choose and which is
// identity-locked like the identity itself. Mirrors the web app's
// genderToAttractedToCategory (src/utils/genderUtils.ts).

import { normalizeGender } from './gender'

export type Category = 'men' | 'women' | 'nonbinary_people' | 'everyone'

export function categoriesOf(genderIdentity: unknown, matchableAs: unknown): string[] {
  // H2: the one normaliser (gender.ts) — Explore, scoring and the founding
  // circle read the same key from the same stored value.
  switch (normalizeGender(genderIdentity)) {
    case 'man':
    case 'trans_man':
      return ['men']
    case 'woman':
    case 'trans_woman':
      return ['women']
    case 'nonbinary':
      return ['nonbinary_people']
    default:
      return Array.isArray(matchableAs) && matchableAs.length ? matchableAs.filter((x): x is string => typeof x === 'string') : ['everyone']
  }
}

// Stage C (decision 2): lifetime Elite and the women's half of a founding
// circle follow how someone is matched — women or nonbinary people, and
// nothing else — not the identity they describe. Someone matched as men (or
// also as men) gets neither.
export function eliteByMatching(genderIdentity: unknown, matchableAs: unknown): boolean {
  const cats = categoriesOf(genderIdentity, matchableAs)
  return cats.length > 0 && cats.every((c) => c === 'women' || c === 'nonbinary_people')
}
