// src/constants/traitToFacetMap.ts
//
// Zylove trait → facet weight mappings. Source: Tier 1 design doc v2,
// Sections 3.1–3.6 and Section 6 (dealbreakers).
//
// Facet vocabulary source: ./facets.ts (32 facets across 7 clusters).
// This file codifies the weighted projection of user-declared enum values
// onto the facet space, used by the facet-profile aggregator to compute a
// user's 32-dimensional psychological vector.
//
// Fidelity note: the Tier 1 spec enumerates some trait/value/vibe/habit
// identifiers that do not currently match the canonical Firestore enums
// in src/types/profile.ts. Enum reconciliation happens in a later sprint
// file; this file is the canonical SOURCE OF TRUTH for the mapping shape
// that the enums will be reconciled against.
//
// Extrapolation markers: [EXTRAP] in a comment flags any mapping not
// explicitly enumerated in the design doc (used for habit tags the doc
// left for implementation phase, and for the non_exclusive dealbreaker
// + shadow facets that the doc only partially specified). Review these
// first if adjusting weights.
//
// Conditional shadow entries: two DEALBREAKER_SHADOW_FACETS entries are
// functions of ShadowContext rather than static arrays (wants_kids,
// different_religion). See the "conditional shadow facet pattern" design
// principle in project memory for when to branch vs. keep static.

import type { FacetId } from './facets'
import type {
  LoveLanguage, Dealbreaker,
  ConflictStyle, TogethernessStyle, StressResponse,
  ParentalCurrent, ParentalIntent,
} from '../types'

// ─── Shared types ─────────────────────────────────────────────────────────

export interface FacetWeight {
  facet:  FacetId
  weight: number   // typically 0.2–1.0; negative values indicate inverse signal
}

// Dealbreaker repulsions come in two shapes:
//   'facet'     — partner's facet score crosses a threshold (optionally compound)
//   'hardFilter' — direct field mismatch (religion, politics, parental state)
export type DealbreakerRepulsion =
  | {
      kind:      'facet'
      facet:     FacetId
      threshold: number
      operator:  'lt' | 'gt'
      compoundWith?: {
        facet:     FacetId
        threshold: number
        operator:  'lt' | 'gt'
      }
    }
  | {
      kind:        'hardFilter'
      field:       'religion' | 'politicalView' | 'parentalStatus' | 'parentalCurrent' | 'parentalIntent' | 'openTo'
      description: string
    }

// Context consumed by conditional shadow facet evaluators. See backlog note
// "conditional shadow facet pattern" for design rationale. Extends as more
// context-sensitive cases land — do NOT add fields speculatively.
export interface ShadowContext {
  parentalCurrent?: 'no_kids' | 'has_kids' | 'prefer_not_to_say'
  religion?:        string     // canonical Religion enum value from DatingProfile
}

// Shadow entry can be a static FacetWeight array (default) or a function of
// user context when the inverse-signal assumption depends on other profile
// fields. See DEALBREAKER_SHADOW_FACETS below and the backlog note for the
// decision framework on when to branch.
export type DealbreakerShadow =
  | FacetWeight[]
  | ((ctx: ShadowContext) => FacetWeight[])

// ─── Tier 1 enum-key types ────────────────────────────────────────────────
// These mirror the design doc's exact identifiers for each category.
// Where canonical enums in src/types/profile.ts already match, we import
// from there. Where the spec uses a different set (personality traits,
// relationship values, weekend vibes), we declare a Tier 1 type here and
// enum reconciliation will happen in a follow-up file.

// Section 3.1 — 19 traits per design doc
export type Tier1PersonalityTrait =
  | 'adventurous' | 'ambitious' | 'analytical' | 'caring' | 'confident'
  | 'creative'    | 'curious'   | 'driven'     | 'easygoing' | 'empathetic'
  | 'funny'       | 'introverted' | 'intuitive' | 'kind' | 'loyal'
  | 'optimistic'  | 'passionate' | 'thoughtful' | 'witty'
  // Web onboarding's options (approved mapping, 2026-10-06)
  | 'spontaneous' | 'intellectual' | 'laid_back' | 'independent' | 'playful'
  | 'genuine'     | 'romantic'     | 'sarcastic' | 'wild_card'   | 'grounded'

// Section 3.2 — 12 values per design doc
export type Tier1RelationshipValue =
  | 'honesty'      | 'communication' | 'loyalty' | 'respect' | 'trust'
  | 'independence' | 'growth'        | 'adventure' | 'humor'
  | 'stability'    | 'passion'       | 'family'
  // Web onboarding's options (approved mapping, 2026-10-06)
  | 'spontaneity'  | 'ambition'      | 'spiritual_alignment' | 'physical_connection'

// Section 3.3 — 10 lifestyle tags per design doc (matches current canonical)
export type Tier1LifestyleTag =
  | 'homebody' | 'adventurer' | 'social_butterfly' | 'workaholic'
  | 'creative' | 'outdoorsy'  | 'nightlife'        | 'wellness_focused'
  | 'foodie'   | 'traveler'

// Section 3.5 — 13 weekend vibes per design doc (different from current canonical)
export type Tier1WeekendVibe =
  | 'hiking' | 'brunch' | 'concert' | 'museum' | 'cooking_at_home'
  | 'road_trip' | 'movie_night' | 'farmers_market' | 'workout'
  | 'reading' | 'party' | 'travel' | 'volunteering'
  // Web onboarding's options (approved mapping, 2026-10-06)
  | 'slow_mornings' | 'cook_something_good' | 'out_in_the_city' | 'get_outside'
  | 'live_something' | 'stay_in_with_someone' | 'go_somewhere' | 'no_plan'
  | 'nightlife' | 'recharge_solo' | 'create_something' | 'host_people' | 'take_care_of_myself'

// Section 3.6 — 20 habit tags from current canonical.
// Design doc enumerates 10 representative habits (meditates, journals,
// therapy, gym_daily, reads_fiction, plays_instrument, cooks_often,
// early_riser, night_owl, pets). Where canonical matches by concept we
// use the doc's weights; the other 10 are [EXTRAP] following the same
// pattern (2-4 facets, 0.3-1.0 weights, Big-Five + attachment grounded).
export type Tier1HabitTag =
  | 'gym_regular'    | 'reader'          | 'gamer'            | 'cook'
  | 'music_lover'    | 'dog_person'      | 'cat_person'       | 'hiker'
  | 'meditates'      | 'drinks_socially' | 'doesnt_drink'     | 'cigarette_smoker'
  | 'vaper'          | '420_friendly'    | 'night_owl'        | 'early_riser'
  | 'puzzle_lover'   | 'netflix_binger'  | 'coffee_addict'    | 'plant_parent'

// ─── Section 3.1 — Personality traits (19) ─────────────────────────────────

export const PERSONALITY_TRAIT_FACET_MAP: Record<Tier1PersonalityTrait, FacetWeight[]> = {
  adventurous: [
    { facet: 'openness_to_novelty', weight: 0.9 },
    { facet: 'risk_tolerance',      weight: 0.5 },
    { facet: 'spontaneity',         weight: 0.4 },
  ],
  ambitious: [
    { facet: 'ambition_drive',      weight: 1.0 },
    { facet: 'conscientiousness',   weight: 0.4 },
  ],
  analytical: [
    { facet: 'intellectual_curiosity', weight: 0.7 },
    { facet: 'conflict_directness',    weight: 0.4 },
  ],
  caring: [
    { facet: 'nurturing_impulse', weight: 0.9 },
    { facet: 'emotional_depth',   weight: 0.5 },
  ],
  confident: [
    { facet: 'public_presentation',  weight: 0.6 },
    { facet: 'emotional_stability',  weight: 0.5 },
    { facet: 'conflict_directness',  weight: 0.4 },
  ],
  creative: [
    { facet: 'openness_to_novelty',    weight: 0.7 },
    { facet: 'aesthetic_sensitivity',  weight: 0.8 },
    { facet: 'intellectual_curiosity', weight: 0.4 },
  ],
  curious: [
    { facet: 'intellectual_curiosity', weight: 1.0 },
    { facet: 'openness_to_novelty',    weight: 0.5 },
  ],
  driven: [
    { facet: 'ambition_drive',    weight: 0.9 },
    { facet: 'conscientiousness', weight: 0.6 },
  ],
  easygoing: [
    { facet: 'emotional_stability',  weight: 0.7 },
    { facet: 'conflict_directness',  weight: -0.4 },
    { facet: 'spontaneity',          weight: 0.4 },
  ],
  empathetic: [
    { facet: 'emotional_depth',    weight: 0.7 },
    { facet: 'nurturing_impulse',  weight: 0.6 },
    { facet: 'self_awareness',     weight: 0.5 },
  ],
  funny: [
    { facet: 'playfulness',            weight: 1.0 },
    { facet: 'verbal_expressiveness',  weight: 0.5 },
  ],
  introverted: [
    { facet: 'extraversion_social', weight: -0.9 },
    { facet: 'social_breadth',      weight: -0.4 },
  ],
  intuitive: [
    { facet: 'self_awareness',         weight: 0.6 },
    { facet: 'emotional_depth',        weight: 0.5 },
    { facet: 'intellectual_curiosity', weight: 0.3 },
  ],
  kind: [
    { facet: 'nurturing_impulse',    weight: 0.7 },
    { facet: 'integrity_valued',     weight: 0.5 },
    { facet: 'emotional_stability',  weight: 0.3 },
  ],
  loyal: [
    { facet: 'commitment_orientation', weight: 0.8 },
    { facet: 'integrity_valued',       weight: 0.6 },
  ],
  optimistic: [
    { facet: 'emotional_stability', weight: 0.6 },
    { facet: 'playfulness',         weight: 0.4 },
  ],
  passionate: [
    { facet: 'emotional_depth', weight: 0.9 },
    { facet: 'sensuality',      weight: 0.4 },
    { facet: 'ambition_drive',  weight: 0.4 },
  ],
  thoughtful: [
    { facet: 'self_awareness',         weight: 0.7 },
    { facet: 'nurturing_impulse',      weight: 0.5 },
    { facet: 'intellectual_curiosity', weight: 0.4 },
  ],
  witty: [
    { facet: 'playfulness',            weight: 0.7 },
    { facet: 'intellectual_curiosity', weight: 0.6 },
    { facet: 'verbal_expressiveness',  weight: 0.7 },
  ],

  // Web onboarding's options (approved mapping, 2026-10-06). One-line
  // reasons; none carries a negative signal that depends on self-awareness.
  // Direct trait; the opposite of liking routine.
  spontaneous: [
    { facet: 'spontaneity',        weight: 1.0 },
    { facet: 'routine_preference', weight: -0.4 },
  ],
  // Driven by ideas; tends to talk them through.
  intellectual: [
    { facet: 'intellectual_curiosity', weight: 1.0 },
    { facet: 'verbal_expressiveness',  weight: 0.3 },
  ],
  // Like easygoing, without its conflict-avoidance weight.
  laid_back: [
    { facet: 'emotional_stability',     weight: 0.7 },
    { facet: 'high_arousal_preference', weight: -0.3 },
    { facet: 'routine_preference',      weight: -0.2 },
  ],
  // Same anchor as the independence value.
  independent: [
    { facet: 'autonomy_valued', weight: 1.0 },
    { facet: 'self_awareness',  weight: 0.2 },
  ],
  // Direct trait.
  playful: [
    { facet: 'playfulness', weight: 1.0 },
    { facet: 'spontaneity', weight: 0.3 },
  ],
  // Authenticity: honesty plus knowing yourself.
  genuine: [
    { facet: 'integrity_valued', weight: 0.8 },
    { facet: 'self_awareness',   weight: 0.4 },
  ],
  // Emotional, sensual and invested.
  romantic: [
    { facet: 'emotional_depth',         weight: 0.6 },
    { facet: 'sensuality',              weight: 0.5 },
    { facet: 'commitment_orientation',  weight: 0.4 },
    { facet: 'physical_expressiveness', weight: 0.3 },
  ],
  // A humor style — deliberately not a negative signal.
  sarcastic: [
    { facet: 'playfulness',           weight: 0.6 },
    { facet: 'verbal_expressiveness', weight: 0.5 },
  ],
  // Unpredictable and up for anything.
  wild_card: [
    { facet: 'spontaneity',         weight: 0.8 },
    { facet: 'risk_tolerance',      weight: 0.7 },
    { facet: 'openness_to_novelty', weight: 0.5 },
    { facet: 'routine_preference',  weight: -0.4 },
  ],
  // Steady and self-aware.
  grounded: [
    { facet: 'emotional_stability', weight: 0.9 },
    { facet: 'self_awareness',      weight: 0.5 },
    { facet: 'routine_preference',  weight: 0.3 },
  ],
}

// ─── Section 3.2 — Relationship values (12) ────────────────────────────────

export const RELATIONSHIP_VALUE_FACET_MAP: Record<Tier1RelationshipValue, FacetWeight[]> = {
  honesty: [
    { facet: 'integrity_valued',    weight: 1.0 },
    { facet: 'conflict_directness', weight: 0.5 },
  ],
  communication: [
    { facet: 'verbal_expressiveness', weight: 0.8 },
    { facet: 'conflict_directness',   weight: 0.6 },
    { facet: 'self_awareness',        weight: 0.4 },
  ],
  loyalty: [
    { facet: 'commitment_orientation', weight: 1.0 },
    { facet: 'integrity_valued',       weight: 0.6 },
  ],
  respect: [
    { facet: 'partnership_egalitarianism', weight: 0.7 },
    { facet: 'integrity_valued',           weight: 0.5 },
  ],
  trust: [
    { facet: 'integrity_valued',      weight: 0.7 },
    { facet: 'emotional_availability', weight: 0.5 },
  ],
  independence: [
    { facet: 'autonomy_valued',     weight: 1.0 },
    { facet: 'extraversion_social', weight: -0.2 },
  ],
  growth: [
    { facet: 'personal_growth_focus', weight: 1.0 },
    { facet: 'self_awareness',        weight: 0.6 },
  ],
  adventure: [
    { facet: 'openness_to_novelty', weight: 0.8 },
    { facet: 'spontaneity',         weight: 0.5 },
  ],
  humor: [
    { facet: 'playfulness', weight: 1.0 },
  ],
  stability: [
    { facet: 'emotional_stability',    weight: 0.6 },
    { facet: 'routine_preference',     weight: 0.7 },
    { facet: 'commitment_orientation', weight: 0.5 },
  ],
  passion: [
    { facet: 'emotional_depth', weight: 0.8 },
    { facet: 'sensuality',      weight: 0.5 },
  ],
  family: [
    { facet: 'family_orientation', weight: 1.0 },
    { facet: 'tradition_valued',   weight: 0.4 },
  ],

  // Web onboarding's options (approved mapping, 2026-10-06).
  // Like adventure, but about pace rather than novelty.
  spontaneity: [
    { facet: 'spontaneity',         weight: 0.9 },
    { facet: 'openness_to_novelty', weight: 0.4 },
  ],
  // Wants a driven partnership.
  ambition: [
    { facet: 'ambition_drive',        weight: 1.0 },
    { facet: 'personal_growth_focus', weight: 0.4 },
  ],
  // Shared belief matters — spiritual, not traditional.
  spiritual_alignment: [
    { facet: 'spiritual_openness', weight: 1.0 },
  ],
  // Direct.
  physical_connection: [
    { facet: 'sensuality',              weight: 0.8 },
    { facet: 'physical_expressiveness', weight: 0.7 },
  ],
}

// ─── Section 3.3 — Lifestyle tags (10) ─────────────────────────────────────

export const LIFESTYLE_TAG_FACET_MAP: Record<Tier1LifestyleTag, FacetWeight[]> = {
  homebody: [
    { facet: 'routine_preference',   weight: 0.7 },
    { facet: 'extraversion_social',  weight: -0.5 },
    { facet: 'social_breadth',       weight: -0.3 },
  ],
  adventurer: [
    { facet: 'openness_to_novelty', weight: 1.0 },
    { facet: 'risk_tolerance',      weight: 0.6 },
    { facet: 'spontaneity',         weight: 0.5 },
  ],
  social_butterfly: [
    { facet: 'extraversion_social', weight: 1.0 },
    { facet: 'social_breadth',      weight: 0.9 },
    { facet: 'public_presentation', weight: 0.5 },
  ],
  workaholic: [
    { facet: 'ambition_drive',    weight: 0.9 },
    { facet: 'conscientiousness', weight: 0.6 },
    { facet: 'autonomy_valued',   weight: 0.3 },
  ],
  creative: [
    { facet: 'aesthetic_sensitivity', weight: 0.9 },
    { facet: 'openness_to_novelty',   weight: 0.5 },
  ],
  outdoorsy: [
    { facet: 'openness_to_novelty',    weight: 0.5 },
    { facet: 'high_arousal_preference', weight: 0.4 },
    { facet: 'lifestyle_discipline',   weight: 0.3 },
  ],
  nightlife: [
    { facet: 'high_arousal_preference', weight: 0.9 },
    { facet: 'social_breadth',          weight: 0.6 },
    { facet: 'spontaneity',             weight: 0.4 },
  ],
  wellness_focused: [
    { facet: 'lifestyle_discipline',   weight: 1.0 },
    { facet: 'personal_growth_focus',  weight: 0.5 },
    { facet: 'self_awareness',         weight: 0.4 },
  ],
  foodie: [
    { facet: 'aesthetic_sensitivity', weight: 0.7 },
    { facet: 'sensuality',            weight: 0.6 },
    { facet: 'openness_to_novelty',   weight: 0.4 },
  ],
  traveler: [
    { facet: 'openness_to_novelty', weight: 0.9 },
    { facet: 'risk_tolerance',      weight: 0.5 },
  ],
}

// ─── Section 3.4 — Love languages (5, dual: give + receive) ────────────────
// Design doc specifies single weights per love language; give and receive
// share the same facet projection. Separate exports preserve the option to
// differentiate weights later (e.g., quality_time give vs. receive may
// project onto different facets once behavioral data accumulates).

const LOVE_LANGUAGE_BASE_MAP: Record<LoveLanguage, FacetWeight[]> = {
  words_of_affirmation: [
    { facet: 'verbal_expressiveness', weight: 1.0 },
    { facet: 'emotional_depth',       weight: 0.3 },
  ],
  acts_of_service: [
    { facet: 'nurturing_impulse', weight: 0.8 },
    { facet: 'conscientiousness', weight: 0.4 },
  ],
  physical_touch: [
    { facet: 'physical_expressiveness', weight: 1.0 },
    { facet: 'sensuality',              weight: 0.5 },
  ],
  quality_time: [
    { facet: 'emotional_availability', weight: 0.9 },
    { facet: 'autonomy_valued',        weight: -0.3 },
  ],
  gift_giving: [
    { facet: 'aesthetic_sensitivity', weight: 0.5 },
    { facet: 'nurturing_impulse',     weight: 0.4 },
  ],
}

export const LOVE_LANG_GIVE_FACET_MAP:    Record<LoveLanguage, FacetWeight[]> = LOVE_LANGUAGE_BASE_MAP
export const LOVE_LANG_RECEIVE_FACET_MAP: Record<LoveLanguage, FacetWeight[]> = LOVE_LANGUAGE_BASE_MAP

// ─── Section 3.5 — Weekend vibes (13) ──────────────────────────────────────

export const WEEKEND_VIBE_FACET_MAP: Record<Tier1WeekendVibe, FacetWeight[]> = {
  hiking: [
    { facet: 'openness_to_novelty', weight: 0.5 },
    { facet: 'lifestyle_discipline', weight: 0.4 },
    { facet: 'routine_preference',   weight: -0.3 },
  ],
  brunch: [
    { facet: 'social_breadth',        weight: 0.6 },
    { facet: 'aesthetic_sensitivity', weight: 0.4 },
    { facet: 'sensuality',            weight: 0.3 },
  ],
  concert: [
    { facet: 'high_arousal_preference', weight: 0.7 },
    { facet: 'social_breadth',          weight: 0.5 },
    { facet: 'aesthetic_sensitivity',   weight: 0.4 },
  ],
  museum: [
    { facet: 'intellectual_curiosity', weight: 0.7 },
    { facet: 'aesthetic_sensitivity',  weight: 0.8 },
  ],
  cooking_at_home: [
    { facet: 'routine_preference', weight: 0.5 },
    { facet: 'nurturing_impulse',  weight: 0.5 },
    { facet: 'sensuality',         weight: 0.4 },
  ],
  road_trip: [
    { facet: 'spontaneity',         weight: 0.7 },
    { facet: 'openness_to_novelty', weight: 0.6 },
  ],
  movie_night: [
    { facet: 'routine_preference',     weight: 0.5 },
    { facet: 'emotional_availability', weight: 0.4 },
  ],
  farmers_market: [
    { facet: 'lifestyle_discipline',  weight: 0.5 },
    { facet: 'aesthetic_sensitivity', weight: 0.4 },
  ],
  workout: [
    { facet: 'lifestyle_discipline',  weight: 1.0 },
    { facet: 'personal_growth_focus', weight: 0.4 },
  ],
  reading: [
    { facet: 'intellectual_curiosity', weight: 0.7 },
    { facet: 'extraversion_social',    weight: -0.4 },
  ],
  party: [
    { facet: 'extraversion_social',     weight: 0.8 },
    { facet: 'high_arousal_preference', weight: 0.7 },
  ],
  travel: [
    { facet: 'openness_to_novelty', weight: 0.9 },
  ],
  volunteering: [
    { facet: 'social_consciousness', weight: 1.0 },
    { facet: 'nurturing_impulse',    weight: 0.6 },
  ],

  // Web onboarding's options (approved mapping, 2026-10-06). Most reuse the
  // design-doc vibe they replaced.
  // Unhurried, low stimulation.
  slow_mornings: [
    { facet: 'routine_preference',      weight: 0.4 },
    { facet: 'high_arousal_preference', weight: -0.4 },
    { facet: 'sensuality',              weight: 0.3 },
  ],
  // cooking_at_home with less routine (it includes trying new recipes).
  cook_something_good: [
    { facet: 'nurturing_impulse',     weight: 0.5 },
    { facet: 'sensuality',            weight: 0.4 },
    { facet: 'aesthetic_sensitivity', weight: 0.3 },
    { facet: 'routine_preference',    weight: 0.2 },
  ],
  // "See what happens."
  out_in_the_city: [
    { facet: 'openness_to_novelty', weight: 0.6 },
    { facet: 'social_breadth',      weight: 0.5 },
    { facet: 'spontaneity',         weight: 0.4 },
  ],
  // Replaces hiking.
  get_outside: [
    { facet: 'openness_to_novelty',  weight: 0.5 },
    { facet: 'lifestyle_discipline', weight: 0.4 },
    { facet: 'routine_preference',   weight: -0.3 },
  ],
  // Replaces concert.
  live_something: [
    { facet: 'high_arousal_preference', weight: 0.7 },
    { facet: 'social_breadth',          weight: 0.5 },
    { facet: 'aesthetic_sensitivity',   weight: 0.4 },
  ],
  // movie_night, but about company.
  stay_in_with_someone: [
    { facet: 'routine_preference',     weight: 0.5 },
    { facet: 'emotional_availability', weight: 0.5 },
    { facet: 'extraversion_social',    weight: -0.2 },
  ],
  // travel plus road_trip.
  go_somewhere: [
    { facet: 'openness_to_novelty', weight: 0.9 },
    { facet: 'spontaneity',         weight: 0.5 },
  ],
  // Direct.
  no_plan: [
    { facet: 'spontaneity',        weight: 1.0 },
    { facet: 'routine_preference', weight: -0.6 },
  ],
  // Replaces party.
  nightlife: [
    { facet: 'extraversion_social',     weight: 0.8 },
    { facet: 'high_arousal_preference', weight: 0.7 },
  ],
  // An explicit introvert reset.
  recharge_solo: [
    { facet: 'extraversion_social', weight: -0.8 },
    { facet: 'autonomy_valued',     weight: 0.4 },
    { facet: 'self_awareness',      weight: 0.3 },
  ],
  // Like the creative trait.
  create_something: [
    { facet: 'aesthetic_sensitivity',  weight: 0.8 },
    { facet: 'openness_to_novelty',    weight: 0.5 },
    { facet: 'intellectual_curiosity', weight: 0.3 },
  ],
  // Social and caring.
  host_people: [
    { facet: 'social_breadth',      weight: 0.7 },
    { facet: 'nurturing_impulse',   weight: 0.6 },
    { facet: 'extraversion_social', weight: 0.5 },
  ],
  // Replaces workout.
  take_care_of_myself: [
    { facet: 'lifestyle_discipline',  weight: 1.0 },
    { facet: 'personal_growth_focus', weight: 0.4 },
  ],
}

// ─── Section 3.6 — Habit tags (20) ─────────────────────────────────────────
// Design doc enumerates 10 representative habits; where a canonical habit
// matches by concept we use the doc's weights. Habits marked [EXTRAP]
// follow the same pattern and are ready for review.

export const HABIT_TAG_FACET_MAP: Record<Tier1HabitTag, FacetWeight[]> = {
  // Aligned with design doc Section 3.6 'gym daily'
  gym_regular: [
    { facet: 'lifestyle_discipline', weight: 1.0 },
    { facet: 'conscientiousness',    weight: 0.6 },
  ],
  // Aligned with 'reads fiction'
  reader: [
    { facet: 'intellectual_curiosity', weight: 0.5 },
    { facet: 'aesthetic_sensitivity',  weight: 0.5 },
    { facet: 'emotional_depth',        weight: 0.4 },
  ],
  // [EXTRAP] Gaming — blend of intellectual engagement + flow-state; mild social-depth signal
  gamer: [
    { facet: 'intellectual_curiosity', weight: 0.4 },
    { facet: 'routine_preference',     weight: 0.3 },
    { facet: 'social_breadth',         weight: -0.2 },
  ],
  // Aligned with 'cooks often'
  cook: [
    { facet: 'nurturing_impulse',    weight: 0.5 },
    { facet: 'lifestyle_discipline', weight: 0.3 },
    { facet: 'sensuality',           weight: 0.4 },
  ],
  // [EXTRAP] Music lover — close analog to design doc 'plays instrument' but receptive, not performative
  music_lover: [
    { facet: 'aesthetic_sensitivity', weight: 0.6 },
    { facet: 'emotional_depth',       weight: 0.4 },
  ],
  // Aligned with 'pets' (specific to dogs — active, nurturing)
  dog_person: [
    { facet: 'nurturing_impulse',      weight: 0.7 },
    { facet: 'emotional_availability', weight: 0.5 },
  ],
  // Aligned with 'pets' (specific to cats — affinity for independent companionship)
  cat_person: [
    { facet: 'nurturing_impulse',      weight: 0.6 },
    { facet: 'emotional_availability', weight: 0.4 },
    { facet: 'autonomy_valued',        weight: 0.3 },
  ],
  // [EXTRAP] Hiker — closely related to 'outdoorsy' lifestyle tag; nature + discipline
  hiker: [
    { facet: 'lifestyle_discipline',    weight: 0.6 },
    { facet: 'openness_to_novelty',     weight: 0.4 },
    { facet: 'high_arousal_preference', weight: 0.3 },
  ],
  // Aligned with design doc exact 'meditates'
  meditates: [
    { facet: 'self_awareness',        weight: 0.8 },
    { facet: 'emotional_stability',   weight: 0.5 },
    { facet: 'personal_growth_focus', weight: 0.6 },
  ],
  // [EXTRAP] Drinks socially — extraversion signal, mild arousal preference
  drinks_socially: [
    { facet: 'extraversion_social',     weight: 0.5 },
    { facet: 'social_breadth',          weight: 0.4 },
    { facet: 'high_arousal_preference', weight: 0.3 },
  ],
  // [EXTRAP] Doesn't drink — lifestyle discipline, wellness orientation
  doesnt_drink: [
    { facet: 'lifestyle_discipline', weight: 0.6 },
    { facet: 'self_awareness',       weight: 0.3 },
  ],
  // [EXTRAP] Cigarette smoker — inverse signal against lifestyle discipline; mild routine preference
  cigarette_smoker: [
    { facet: 'lifestyle_discipline', weight: -0.8 },
    { facet: 'routine_preference',   weight: 0.3 },
  ],
  // [EXTRAP] Vaper — similar inverse discipline signal, slightly weaker than cigarettes
  vaper: [
    { facet: 'lifestyle_discipline', weight: -0.6 },
  ],
  // [EXTRAP] 420-friendly — openness, mild spontaneity, inverse routine
  '420_friendly': [
    { facet: 'openness_to_novelty', weight: 0.5 },
    { facet: 'spontaneity',         weight: 0.4 },
    { facet: 'routine_preference',  weight: -0.3 },
  ],
  // Aligned with design doc 'night owl'
  night_owl: [
    { facet: 'high_arousal_preference', weight: 0.5 },
    { facet: 'routine_preference',      weight: -0.4 },
    { facet: 'spontaneity',             weight: 0.3 },
  ],
  // Aligned with design doc 'early riser'
  early_riser: [
    { facet: 'lifestyle_discipline', weight: 0.7 },
    { facet: 'conscientiousness',    weight: 0.5 },
    { facet: 'routine_preference',   weight: 0.6 },
  ],
  // [EXTRAP] Puzzle lover — analytical curiosity, patience (conscientiousness-adjacent)
  puzzle_lover: [
    { facet: 'intellectual_curiosity', weight: 0.7 },
    { facet: 'conscientiousness',      weight: 0.4 },
  ],
  // [EXTRAP] Netflix binger — low-arousal leisure, routine preference, mild introversion
  netflix_binger: [
    { facet: 'routine_preference',      weight: 0.5 },
    { facet: 'high_arousal_preference', weight: -0.3 },
    { facet: 'extraversion_social',     weight: -0.3 },
  ],
  // [EXTRAP] Coffee addict — ritualistic, aesthetic consumer, mild conscientiousness
  coffee_addict: [
    { facet: 'routine_preference',    weight: 0.5 },
    { facet: 'aesthetic_sensitivity', weight: 0.3 },
  ],
  // [EXTRAP] Plant parent — nurturing + aesthetic; mild conscientiousness (plants need care)
  plant_parent: [
    { facet: 'nurturing_impulse',     weight: 0.6 },
    { facet: 'aesthetic_sensitivity', weight: 0.4 },
    { facet: 'conscientiousness',     weight: 0.3 },
  ],
}

// ─── Go Deeper + Parental Intent Facet Maps ─────────────────────────────────
// Source: Tier 1 design doc v2, §§4.3, 5.2, 5.3, 5.4

export const CONFLICT_STYLE_FACET_MAP: Readonly<Record<ConflictStyle, FacetWeight[]>> = {
  direct:        [
    { facet: 'conflict_directness',   weight:  1.0 },
    { facet: 'verbal_expressiveness', weight:  0.6 },
    { facet: 'integrity_valued',      weight:  0.3 },
  ],
  process_first: [
    { facet: 'self_awareness',        weight:  0.7 },
    { facet: 'conflict_directness',   weight:  0.5 },
    { facet: 'emotional_stability',   weight:  0.5 },
  ],
  avoid: [
    { facet: 'conflict_directness',   weight: -0.7 },
    { facet: 'emotional_availability',weight: -0.2 },
  ],
  situational: [
    { facet: 'conflict_directness',   weight:  0.4 },
    { facet: 'self_awareness',        weight:  0.6 },
  ],
}

export const TOGETHERNESS_STYLE_FACET_MAP: Readonly<Record<TogethernessStyle, FacetWeight[]>> = {
  entwined: [
    { facet: 'emotional_availability', weight:  0.9 },
    { facet: 'autonomy_valued',        weight: -0.5 },
  ],
  separate_plus_deep: [
    { facet: 'emotional_availability', weight:  0.7 },
    { facet: 'autonomy_valued',        weight:  0.6 },
    { facet: 'self_awareness',         weight:  0.4 },
  ],
  independent: [
    { facet: 'autonomy_valued',        weight:  1.0 },
    { facet: 'emotional_availability', weight:  0.4 },
  ],
  in_between: [
    { facet: 'emotional_availability', weight:  0.5 },
    { facet: 'autonomy_valued',        weight:  0.5 },
  ],
}

export const STRESS_RESPONSE_FACET_MAP: Readonly<Record<StressResponse, FacetWeight[]>> = {
  power_through: [
    { facet: 'conscientiousness',      weight:  0.7 },
    { facet: 'ambition_drive',         weight:  0.5 },
    { facet: 'emotional_stability',    weight:  0.3 },
    { facet: 'self_awareness',         weight: -0.2 },
  ],
  step_back: [
    { facet: 'self_awareness',         weight:  0.7 },
    { facet: 'emotional_stability',    weight:  0.7 },
    { facet: 'lifestyle_discipline',   weight:  0.5 },
  ],
  talk_it_out: [
    { facet: 'verbal_expressiveness',  weight:  0.9 },
    { facet: 'emotional_availability', weight:  0.7 },
    { facet: 'social_breadth',         weight:  0.4 },
  ],
  get_quiet: [
    { facet: 'self_awareness',         weight:  0.9 },
    { facet: 'emotional_depth',        weight:  0.6 },
    { facet: 'extraversion_social',    weight: -0.5 },
  ],
}

export const PARENTAL_CURRENT_FACET_MAP: Readonly<Record<ParentalCurrent, FacetWeight[]>> = {
  has_kids: [
    { facet: 'nurturing_impulse',      weight:  0.5 },
    { facet: 'family_orientation',     weight:  0.4 },
  ],
  no_kids: [],
}

export const PARENTAL_INTENT_FACET_MAP: Readonly<Record<ParentalIntent, FacetWeight[]>> = {
  wants_first:      [
    { facet: 'family_orientation',     weight:  0.9 },
    { facet: 'commitment_orientation', weight:  0.3 },
  ],
  wants_more:       [
    { facet: 'family_orientation',     weight:  0.9 },
    { facet: 'nurturing_impulse',      weight:  0.4 },
  ],
  open_to_more:     [
    { facet: 'family_orientation',     weight:  0.3 },
  ],
  doesnt_want_any:  [
    { facet: 'family_orientation',     weight: -0.4 },
    { facet: 'autonomy_valued',        weight:  0.3 },
  ],
  doesnt_want_more: [
    { facet: 'family_orientation',     weight:  0.6 },
    { facet: 'nurturing_impulse',      weight:  0.3 },
  ],
  undecided:        [],
}

// ─── Section 6 — Dealbreaker repulsions ────────────────────────────────────
// Current 9-value canonical enum (after 2026-04-20 strip). Mappings draw
// from design doc Section 6.1 where the label matches conceptually; the
// non_exclusive case is [EXTRAP] since it wasn't in the original 13.

export const DEALBREAKER_REPULSION_MAP: Record<Dealbreaker, DealbreakerRepulsion> = {
  // Design doc 'smokes' → lifestyle_discipline < 0.5
  cigarette_smoker: {
    kind:      'facet',
    facet:     'lifestyle_discipline',
    threshold: 0.5,
    operator:  'lt',
  },
  // [EXTRAP] Vaper — same signal as cigarette_smoker per design doc's 'smokes' rule
  vaper: {
    kind:      'facet',
    facet:     'lifestyle_discipline',
    threshold: 0.5,
    operator:  'lt',
  },
  // Design doc 'heavy drinker' → lifestyle_discipline < 0.4 AND emotional_stability < 0.5
  heavy_drinker: {
    kind:      'facet',
    facet:     'lifestyle_discipline',
    threshold: 0.4,
    operator:  'lt',
    compoundWith: {
      facet:     'emotional_stability',
      threshold: 0.5,
      operator:  'lt',
    },
  },
  // Hard filter — partner.parentalStatus === 'has_kids'
  has_kids: {
    kind:        'hardFilter',
    field:       'parentalStatus',
    description: 'Excludes partners with parentalStatus === "has_kids"',
  },
  partner_has_kids: {
    kind:        'hardFilter',
    field:       'parentalCurrent',
    description: 'Excludes partners with parentalCurrent === "has_kids" (or legacy parentalStatus === "has_kids")',
  },
  // Hard filter — partner.parentalStatus === 'wants_kids'
  wants_kids: {
    kind:        'hardFilter',
    field:       'parentalStatus',
    description: 'Excludes partners with parentalStatus === "wants_kids"',
  },
  partner_wants_kids: {
    kind:        'hardFilter',
    field:       'parentalIntent',
    description: 'Excludes partners with parentalIntent === "wants_first"|"wants_more" (or legacy parentalStatus === "wants_kids")',
  },
  // Hard filter — partner.parentalStatus === 'child_free'
  doesnt_want_kids: {
    kind:        'hardFilter',
    field:       'parentalStatus',
    description: 'Excludes partners with parentalStatus === "child_free"',
  },
  partner_doesnt_want_kids: {
    kind:        'hardFilter',
    field:       'parentalIntent',
    description: 'Excludes partners with parentalIntent === "doesnt_want_any"|"doesnt_want_more" (or legacy parentalStatus === "child_free")',
  },
  // [EXTRAP] Non-exclusive — not in design doc. Closest facet: commitment_orientation.
  // Also triggers on partner.openTo containing open_relationship/casual/polyamory.
  non_exclusive: {
    kind:        'hardFilter',
    field:       'openTo',
    description: 'Excludes partners whose openTo includes open_relationship, casual, or polyamory',
  },
  // Hard filter — partner.religion !== user.religion (both non-neutral)
  different_religion: {
    kind:        'hardFilter',
    field:       'religion',
    description: 'Excludes partners whose religion differs; skip if either side is prefer_not_to_say',
  },
  // Hard filter — partner.politicalView !== user.politicalView (both non-neutral)
  different_politics: {
    kind:        'hardFilter',
    field:       'politicalView',
    description: 'Excludes partners whose politicalView differs; skip if either side is apolitical or prefer_not_to_say',
  },
}

// ─── Section 6.3 — Shadow facet adjustments ────────────────────────────────
// "What you reject informs who you are." A dealbreaker implicitly strengthens
// the inverse facet on the user's own facet profile (if not already higher).
// Design doc v2 only explicitly states the heavy_drinker → lifestyle_discipline
// (+0.3) example; most remaining entries are [EXTRAP] — same pattern, inverse
// of the repulsion facet at +0.3 weight.
//
// Two entries are CONDITIONAL functions (see `DealbreakerShadow` type above
// and the "conditional shadow facet pattern" backlog note for rationale):
//   - wants_kids        → branches on ctx.parentalCurrent
//   - different_religion → branches on ctx.religion (secular vs affiliated)
//
// Consumers must route every read through resolveShadowFacets() to normalize
// static and function entries into a FacetWeight[].

export const DEALBREAKER_SHADOW_FACETS: Record<Dealbreaker, DealbreakerShadow> = {
  // [EXTRAP] Mirrors cigarette_smoker's lifestyle_discipline repulsion
  cigarette_smoker: [
    { facet: 'lifestyle_discipline', weight: 0.3 },
  ],
  // [EXTRAP] Same as cigarette_smoker
  vaper: [
    { facet: 'lifestyle_discipline', weight: 0.3 },
  ],
  // Design doc explicit example — two-facet shadow from compound repulsion
  heavy_drinker: [
    { facet: 'lifestyle_discipline', weight: 0.3 },
    { facet: 'emotional_stability', weight: 0.2 },
  ],
  // [EXTRAP] User who rejects partners with kids values autonomy — less family entanglement.
  // TODO (conditional shadow facet pattern): considered and deferred 2026-04-20. A user who
  // themselves has kids AND holds this dealbreaker has ambiguous underlying motivation
  // (complexity avoidance? relationship-focus? financial boundaries?) — none cleanly fit
  // conscientiousness or any other single facet. Static autonomy_valued +0.3 is defensible
  // across interpretations. Revisit after TestFlight behavioral data.
  has_kids: [
    { facet: 'autonomy_valued', weight: 0.3 },
  ],
  partner_has_kids: [
    { facet: 'autonomy_valued', weight: 0.3 },
  ],
  // CONDITIONAL: user's parentalCurrent changes the inverse-signal interpretation.
  // A user with existing kids who rejects partners wanting MORE kids is not low on
  // family_orientation — they have family, they love family, they just don't want to
  // start over. Applying family_orientation -0.3 to that user would mis-profile them.
  wants_kids: (ctx) => {
    if (ctx.parentalCurrent === 'has_kids') {
      return [{ facet: 'autonomy_valued', weight: 0.2 }]
    }
    if (ctx.parentalCurrent === 'no_kids') {
      return [
        { facet: 'family_orientation', weight: -0.3 },
        { facet: 'autonomy_valued',    weight: 0.2 },
      ]
    }
    // undefined or 'prefer_not_to_say' → conservative default (positive shadow only)
    return [{ facet: 'autonomy_valued', weight: 0.2 }]
  },
  partner_wants_kids: (ctx) => {
    if (ctx.parentalCurrent === 'has_kids') {
      return [{ facet: 'autonomy_valued', weight: 0.2 }]
    }
    if (ctx.parentalCurrent === 'no_kids') {
      return [
        { facet: 'family_orientation', weight: -0.3 },
        { facet: 'autonomy_valued',    weight: 0.2 },
      ]
    }
    return [{ facet: 'autonomy_valued', weight: 0.2 }]
  },
  // [EXTRAP] User who rejects partners who don't want kids strongly values family
  doesnt_want_kids: [
    { facet: 'family_orientation', weight: 0.3 },
  ],
  partner_doesnt_want_kids: [
    { facet: 'family_orientation', weight: 0.3 },
  ],
  // [EXTRAP] User who rejects non-exclusive partners values commitment
  non_exclusive: [
    { facet: 'commitment_orientation', weight: 0.3 },
  ],
  // CONDITIONAL: user's own religion changes the inverse-signal interpretation.
  // An atheist/agnostic user rejecting religious mismatch is motivated by
  // intellectual-integrity alignment, not spirituality. Attributing spiritual_openness
  // to that user would mis-profile them. Religious users still get the faith/tradition
  // dual-shadow because that's where the rejection signal actually points.
  different_religion: (ctx) => {
    const secularReligions = new Set(['atheist', 'agnostic'])
    if (ctx.religion && secularReligions.has(ctx.religion)) {
      return [{ facet: 'integrity_valued', weight: 0.3 }]
    }
    return [
      { facet: 'spiritual_openness', weight: 0.2 },
      { facet: 'tradition_valued',   weight: 0.2 },
    ]
  },
  // [EXTRAP] User who rejects political mismatches shows social consciousness
  different_politics: [
    { facet: 'social_consciousness', weight: 0.3 },
  ],
}

// Normalizes a DealbreakerShadow (static or function) into a FacetWeight[].
// All consumers of DEALBREAKER_SHADOW_FACETS must route through this helper.
export function resolveShadowFacets(
  shadow: DealbreakerShadow,
  ctx:    ShadowContext,
): FacetWeight[] {
  return typeof shadow === 'function' ? shadow(ctx) : shadow
}
