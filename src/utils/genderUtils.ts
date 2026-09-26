// src/utils/genderUtils.ts
//
// Maps a user's genderIdentity to the AttractedTo categories they would be
// surfaced under. Used for bilateral discovery filtering — the viewer's
// own gender determines which candidates' attractedTo arrays they belong to.
//
// For off-map identities (genderfluid/agender/self_describe) the user
// explicitly declares matchableAs during onboarding.

export function genderToAttractedToCategory(
  genderIdentity: string,
  matchableAs?: string[],
): string[] {
  switch (genderIdentity) {
    case 'man':         return ['men']
    case 'woman':       return ['women']
    case 'trans_man':   return ['men']
    case 'trans_woman': return ['women']
    case 'nonbinary':   return ['nonbinary_people']
    default:
      // genderfluid, agender, self_describe — use matchableAs
      return matchableAs ?? ['everyone']
  }
}
