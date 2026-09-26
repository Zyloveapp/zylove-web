// src/types/scorecard.ts
//
// Compatibility scorecard system.
//
// Three views of the same data depending on who's looking and when:
//
//  1. LIKER (pre-match)     → single % number only. No detail.
//  2. RECEIVER (always)     → full trait-by-trait breakdown, private to her.
//  3. LIKER (post-match)    → full trait-by-trait reveal. Drives first message.
//
// Visibility: simplified to 8 section-level toggles.
// Always visible (cannot be hidden): name, age, intent, photos.

// ─── Scorecard ────────────────────────────────────────────────────────────────

export interface ScorecardCategory {
  id: string
  label: string
  emoji: string
  score: number
  weight: number
  traits: ScorecardTrait[]
}

export interface ScorecardTrait {
  id: string
  label: string
  emoji: string
  theirValue: string
  herPreference: string   // NEVER shown to liker
  match: 'strong' | 'partial' | 'none' | 'dealbreaker'
  contributionPct: number
}

export interface CompatibilityScorecard {
  likerUid: string
  receiverUid: string
  totalScore: number
  categories: ScorecardCategory[]
  dealbreakersTriggered: string[]
  computedAt: number
  publicScore: number         // rounded to nearest 5 for mystery
  matchRevealUnlocked: boolean

  sparkScore?: number
  playScore?: number
  tier1?: {
    archetype?: {
      id: string
      label: string
      copy: string
      confidence: number
    }
    combinedScore?: number
    asymmetryGap?: number
    dataConfidence?: number
  } | null
  breakdown?: {
    spark?: Record<string, number>
    play?: Record<string, number>
  }
}

// ─── Completeness scoring ─────────────────────────────────────────────────────

export type VisibilitySection =
  | 'basics'
  | 'intent'
  | 'about_me'
  | 'lifestyle'
  | 'prompts'
  | 'what_i_seek'

export interface CompletenessScore {
  total: number
  bySection: Record<VisibilitySection, number>
  unlockedFeatures: UnlockedFeature[]
  nextUnlock: { feature: UnlockedFeature; requiredScore: number } | null
}

export type UnlockedFeature =
  | 'top_10_active'
  | 'see_who_viewed'
  | 'compatibility_preview'
  | 'priority_placement'
  | 'full_insights'

export const UNLOCK_THRESHOLDS: Record<UnlockedFeature, number> = {
  top_10_active:          30,
  see_who_viewed:         50,
  compatibility_preview:  70,
  priority_placement:     90,
  full_insights:          100,
}

export const UNLOCK_LABELS: Record<UnlockedFeature, { label: string; description: string; emoji: string }> = {
  top_10_active:         { emoji: '✦', label: 'Top 10 unlocked',       description: 'Your likes are now being ranked for you.' },
  see_who_viewed:        { emoji: '👁',  label: 'See who viewed you',   description: 'Find out who checked your profile.' },
  compatibility_preview: { emoji: '💡', label: 'Match potential score', description: 'See how well you\'d match with people in your feed.' },
  priority_placement:    { emoji: '⚡', label: 'Priority placement',    description: 'Your profile gets boosted in discovery.' },
  full_insights:         { emoji: '📊', label: 'Full like insights',    description: 'Detailed analytics on who\'s liking you and why.' },
}

export function computeCompleteness(
  profile: Record<string, any>,
  seekingPrefs: Record<string, any> | null,
  promptAnswers: { promptId: string }[]
): CompletenessScore {
  const scores: Record<VisibilitySection, { earned: number; max: number }> = {
    basics:      { earned: 0, max: 0 },
    intent:      { earned: 0, max: 0 },
    about_me:    { earned: 0, max: 0 },
    lifestyle:   { earned: 0, max: 0 },
    prompts:     { earned: 0, max: 0 },
    what_i_seek: { earned: 0, max: 0 },
  }

  const check = (section: VisibilitySection, value: any) => {
    scores[section].max++
    const filled = Array.isArray(value) ? value.length > 0 : !!value
    if (filled) scores[section].earned++
  }

  check('basics', profile.photoURLs)
  check('basics', profile.displayName)
  check('basics', profile.age)
  check('basics', profile.pronouns)

  check('intent', profile.intent)
  check('intent', profile.playStyle ?? profile.relationshipStyle)

  check('about_me', profile.heightCm ?? profile.height)
  check('about_me', profile.bodyType)
  check('about_me', profile.personalityTraits ?? profile.personalityTags)
  check('about_me', profile.lifestyleTags)
  check('about_me', profile.relationshipValues ?? profile.topValues)

  check('lifestyle', profile.habitTags)
  check('lifestyle', profile.weekendVibes)
  check('lifestyle', profile.parentalStatus ?? profile.hasKids)
  check('lifestyle', profile.openTo)

  scores['prompts'].max = 4
  scores['prompts'].earned = Math.min(promptAnswers.length, 4)

  if (seekingPrefs) {
    check('what_i_seek', seekingPrefs.personalityPriorities)
    check('what_i_seek', seekingPrefs.topValues)
    check('what_i_seek', seekingPrefs.heightPreference)
    check('what_i_seek', seekingPrefs.smokingDealbreaker)
    check('what_i_seek', seekingPrefs.kidsPreference)
  } else {
    scores['what_i_seek'].max = 5
  }

  const bySection = {} as Record<VisibilitySection, number>
  let totalEarned = 0
  let totalMax = 0

  for (const [section, { earned, max }] of Object.entries(scores)) {
    bySection[section as VisibilitySection] = max > 0 ? Math.round((earned / max) * 100) : 0
    totalEarned += earned
    totalMax += max
  }

  const total = totalMax > 0 ? Math.round((totalEarned / totalMax) * 100) : 0

  const unlockedFeatures = (Object.entries(UNLOCK_THRESHOLDS) as [UnlockedFeature, number][])
    .filter(([, threshold]) => total >= threshold)
    .map(([feature]) => feature)

  const nextUnlock = (Object.entries(UNLOCK_THRESHOLDS) as [UnlockedFeature, number][])
    .filter(([, threshold]) => total < threshold)
    .sort(([, a], [, b]) => a - b)[0]

  return {
    total,
    bySection,
    unlockedFeatures,
    nextUnlock: nextUnlock
      ? { feature: nextUnlock[0], requiredScore: nextUnlock[1] }
      : null,
  }
}

// ─── Spark completeness ───────────────────────────────────────────────────────

export function computeSparkCompleteness(profile: Record<string, any>): number {
  const fields = [
    profile.displayName,
    profile.age,
    profile.photoURLs?.length > 0 ? true : null,
    profile.bio,
    profile.pronouns,
    profile.genderIdentity,
    profile.attractedTo?.length > 0 ? true : null,
    profile.heightCm ?? profile.height,
    profile.bodyType,
    profile.personalityTraits?.length > 0 || profile.personalityTags?.length > 0 ? true : null,
    profile.lifestyleTags?.length > 0 ? true : null,
    profile.relationshipValues?.length > 0 || profile.topValues?.length > 0 ? true : null,
    profile.intent,
    profile.relationshipStatus ?? profile.relationshipStyle,
    profile.promptAnswers?.length >= 2 ? true : null,
  ]
  const filled = fields.filter(Boolean).length
  return Math.round((filled / fields.length) * 100)
}

// ─── Play completeness ────────────────────────────────────────────────────────

export function computePlayCompleteness(profile: Record<string, any>): number {
  const fields = [
    profile.displayName,
    profile.age,
    profile.photoURLs?.length > 0 ? true : null,
    profile.playBio ?? profile.bio,
    profile.spiceLevel,
    profile.playInterestTags?.length > 0 ? true : null,
    profile.playStyle,
    profile.attractedTo?.length > 0 ? true : null,
    profile.promptAnswers?.length >= 1 ? true : null,
  ]
  const filled = fields.filter(Boolean).length
  return Math.round((filled / fields.length) * 100)
}
