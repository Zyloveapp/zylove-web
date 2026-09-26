// src/types/preferences.ts
//
// What someone is looking for — captured during onboarding.
// Used by the Top 10 scoring engine to rank incoming likes.
// Never shown to the liker — used only for internal scoring.

// ─── Physical Preferences ─────────────────────────────────────────────────────

export type HeightPreference =
  | 'no_preference'
  | 'shorter_than_me'
  | 'similar_to_me'
  | 'taller_than_me'
  | 'significantly_taller'

export type BodyTypePreference =
  | 'no_preference'
  | 'slim'
  | 'athletic'
  | 'average'
  | 'curvy'
  | 'heavyset'
  | 'any_muscular'

export type AgeGapPreference = {
  youngerBy: number
  olderBy: number
}

// ─── Personality & Lifestyle Preferences ──────────────────────────────────────

export type PersonalityTrait =
  | 'ambitious'         | 'laid_back'
  | 'funny'             | 'deep_thinker'
  | 'adventurous'       | 'homebody'
  | 'social_butterfly'  | 'introverted'
  | 'affectionate'      | 'independent'
  | 'spontaneous'       | 'planner'
  | 'spiritual'         | 'logical'
  | 'nurturing'         | 'driven'

export type CommunicationStyle =
  | 'texter'
  | 'caller'
  | 'quality_time'
  | 'low_maintenance'

export type EnergyLevel =
  | 'high_energy'
  | 'balanced'
  | 'low_key'

// ─── Dealbreakers ─────────────────────────────────────────────────────────────

export type Dealbreaker =
  | 'smoker'
  | 'heavy_drinker'
  | 'no_job'
  | 'has_kids'
  | 'wants_kids'
  | 'child_free_only'
  | 'different_religion'
  | 'different_politics'
  | 'long_distance'
  | 'non_monogamous'
  | 'not_verified'
  | 'no_photo'

// ─── Full Preference Profile ──────────────────────────────────────────────────

export interface PartnerPreferences {
  uid: string
  heightPreference: HeightPreference
  bodyTypePreferences: BodyTypePreference[]
  ageGap: AgeGapPreference
  attractedToGenders: string[]
  mustHaveTraits: PersonalityTrait[]
  niceToHaveTraits: PersonalityTrait[]
  preferredCommunicationStyle: CommunicationStyle | null
  preferredEnergyLevel: EnergyLevel | null
  importantLifestyleTags: string[]
  dealbreakers: Dealbreaker[]
  intentPreference: 'same_only' | 'open_ok'
  weights: PreferenceWeights
}

export interface PreferenceWeights {
  physical: number
  personality: number
  lifestyle: number
  dealbreakers: number
}

export const DEFAULT_WEIGHTS: PreferenceWeights = {
  physical: 0.25,
  personality: 0.45,
  lifestyle: 0.30,
  dealbreakers: 1.0,
}

// ─── Display Helpers ──────────────────────────────────────────────────────────

export const PERSONALITY_TRAIT_LABELS: Record<PersonalityTrait, string> = {
  ambitious: '🔥 Ambitious',        laid_back: '😌 Laid-back',
  funny: '😂 Funny',                deep_thinker: '🧠 Deep thinker',
  adventurous: '🧗 Adventurous',    homebody: '🏠 Homebody',
  social_butterfly: '🦋 Social',    introverted: '🎧 Introverted',
  affectionate: '🤗 Affectionate',  independent: '⚡ Independent',
  spontaneous: '🎲 Spontaneous',    planner: '📅 Planner',
  spiritual: '🕊️ Spiritual',        logical: '🔬 Logical',
  nurturing: '💛 Nurturing',        driven: '🎯 Driven',
}

export const DEALBREAKER_LABELS: Record<Dealbreaker, string> = {
  smoker: 'Smoker',
  heavy_drinker: 'Heavy drinker',
  no_job: 'Unemployed',
  has_kids: 'Has kids',
  wants_kids: 'Wants kids',
  child_free_only: 'Child-free only',
  different_religion: 'Different religion',
  different_politics: 'Different politics',
  long_distance: 'Long distance',
  non_monogamous: 'Non-monogamous',
  not_verified: 'Not verified',
  no_photo: 'No photos',
}

export const HEIGHT_LABELS: Record<HeightPreference, string> = {
  no_preference: 'No preference',
  shorter_than_me: 'Shorter than me',
  similar_to_me: 'Similar height',
  taller_than_me: 'A bit taller (1–3 in)',
  significantly_taller: 'Noticeably taller (4+ in)',
}

export const BODY_TYPE_LABELS: Record<BodyTypePreference, string> = {
  no_preference: 'No preference',
  slim: 'Slim',
  athletic: 'Athletic',
  average: 'Average',
  curvy: 'Curvy',
  heavyset: 'Heavyset',
  any_muscular: 'Muscular',
}

export const ENERGY_LABELS: Record<EnergyLevel, string> = {
  high_energy: '⚡ High energy — always doing something',
  balanced: '☯️ Balanced — active but knows when to chill',
  low_key: '🌿 Low-key — calm, easy pace',
}

export const COMMUNICATION_LABELS: Record<CommunicationStyle, string> = {
  texter: '💬 Texter — I like staying in touch',
  caller: '📞 Caller — I prefer hearing your voice',
  quality_time: '🤝 Quality time person — in-person over DMs',
  low_maintenance: '🌊 Low maintenance — comfortable with space',
}
