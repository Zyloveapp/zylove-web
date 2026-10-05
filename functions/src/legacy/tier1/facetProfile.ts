// src/services/facetProfile.ts
//
// Zylove facet profile computation — pure function. Given a user's declared
// onboarding data, produces the 32-dimensional facet vector that downstream
// compatibility scoring and archetype classification consume.
//
// Dependencies:
//   - src/constants/facets.ts           (FacetId, ALL_FACET_IDS, 32-facet vocabulary)
//   - src/constants/traitToFacetMap.ts  (per-category mappings + shadow facet resolver)
//
// Math source: Tier 1 design doc v2, Section 8.1.
// Formula:       normalized[f] = clamp(0.5 + raw[f] / SCALE, 0, 1)
//                where raw[f] = sum of (mapping weight * signal) contributions
//                and signal = 1 for each user-selected input that maps to f.
//
// Output range: [0, 1] with 0.5 as neutral / no-data origin.
//   - 0.5   → no data or neutral expression
//   - > 0.5 → positive expression of the facet
//   - < 0.5 → negative expression (user actively signals the opposite)
//
// SCALE = 6.0 as a starting tuning value; tune from TestFlight behavioral data
// if saturation clustering or mid-range bunching shows up.
//
// This service does NOT apply dealbreaker REPULSIONS (those affect candidate
// scoring, not the user's own facet vector). It DOES apply dealbreaker SHADOW
// facets — "what you reject informs who you are" — which live on the user's
// own vector per design doc Section 6.3.

// `__DEV__` is a React Native global. On the server, it's undefined at
// runtime. The `typeof __DEV__ !== 'undefined'` guards below handle that;
// this declare gives TypeScript awareness of the symbol.
declare const __DEV__: boolean | undefined

import type { FacetId } from './facets'
import { ALL_FACET_IDS } from './facets'
import {
  PERSONALITY_TRAIT_FACET_MAP,
  RELATIONSHIP_VALUE_FACET_MAP,
  LIFESTYLE_TAG_FACET_MAP,
  LOVE_LANG_GIVE_FACET_MAP,
  LOVE_LANG_RECEIVE_FACET_MAP,
  WEEKEND_VIBE_FACET_MAP,
  HABIT_TAG_FACET_MAP,
  CONFLICT_STYLE_FACET_MAP,
  TOGETHERNESS_STYLE_FACET_MAP,
  STRESS_RESPONSE_FACET_MAP,
  PARENTAL_CURRENT_FACET_MAP,
  PARENTAL_INTENT_FACET_MAP,
  DEALBREAKER_SHADOW_FACETS,
  resolveShadowFacets,
  type FacetWeight,
  type ShadowContext,
} from './traitToFacetMap'
import type { DatingProfile } from '../types'

// ─── Public types ─────────────────────────────────────────────────────────

export type FacetVector = Record<FacetId, number>

// Exported for unit tests. Tuning constant: higher = more mid-range bunching,
// lower = faster saturation at the endpoints. Initial value 6.0; revisit on
// behavioral data post-TestFlight.
export const SCALE = 6.0

// ─── Helpers (non-exported) ───────────────────────────────────────────────

/** Clamps value to [lo, hi] range inclusive. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

/**
 * Transforms a raw accumulated weight into a [0, 1] facet score.
 * 0.5 is the neutral/no-data origin; positive raw pushes above, negative below.
 */
function normalize(raw: number, scale: number): number {
  return clamp(0.5 + raw / scale, 0, 1)
}

/**
 * Folds a user's selections for one category into the running raw vector.
 * Unknown values (not present in the mapping) are silently skipped in prod;
 * __DEV__ surfaces them as warnings so trait-enum drift is visible during
 * development without breaking user-facing flows.
 */
function accumulate(
  values: readonly string[] | undefined,
  map:    Readonly<Record<string, FacetWeight[]>>,
  raw:    Record<string, number>,
  categoryLabel: string,
): void {
  if (!Array.isArray(values) || values.length === 0) return
  for (const value of values) {
    const contributions = map[value]
    if (!contributions) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(`[facetProfile] unmapped ${categoryLabel} value: "${value}"`)
      }
      continue
    }
    for (const { facet, weight } of contributions) {
      raw[facet] = (raw[facet] ?? 0) + weight
    }
  }
}

/**
 * Single-value variant of accumulate() for enum-valued onboarding fields
 * (conflictStyle, togethernessStyle, stressResponse, parentalCurrent,
 * parentalIntent). Preserves type-safe key narrowing across categories —
 * passing the wrong map for a field type is a compile error.
 */
function accumulateSingle<T extends string>(
  value: T | null | undefined,
  map:   Readonly<Record<T, FacetWeight[]>>,
  raw:   Record<string, number>,
  categoryLabel: string,
): void {
  if (!value) return
  const contributions = map[value]
  if (!contributions) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(`[facetProfile] unmapped ${categoryLabel} value: "${value}"`)
    }
    return
  }
  for (const { facet, weight } of contributions) {
    raw[facet] = (raw[facet] ?? 0) + weight
  }
}

/** Builds the ShadowContext consumed by conditional shadow facet evaluators. */
function buildShadowContext(user: DatingProfile): ShadowContext {
  const legacy = (user as any).parentalStatus
  const parentalCurrent = user.parentalCurrent
    ?? (legacy === 'has_kids' ? 'has_kids'
        : (legacy === 'child_free' || legacy === 'wants_kids' || legacy === 'open_to_kids') ? 'no_kids'
        : 'prefer_not_to_say')
  return {
    parentalCurrent,
    religion: (user as any).religion,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Computes a user's 32-dimensional psychological facet vector from their
 * declared onboarding data.
 *
 * Pure function: same input → same output, no side effects (aside from the
 * optional __DEV__ warning on unmapped enum values).
 *
 * Empty / missing fields contribute nothing. A user with no onboarding data
 * returns a vector of all 0.5 neutrals — correct representation of
 * "no information" rather than "low expression everywhere."
 */
export function computeFacetProfile(user: DatingProfile): FacetVector {
  // Initialize raw accumulator at zero for every canonical facet.
  const raw: Record<string, number> = {}
  for (const facetId of ALL_FACET_IDS) {
    raw[facetId] = 0
  }

  // Per-category trait contributions. Each helper is defensive against
  // missing arrays / unknown values — no single bad field breaks the vector.
  accumulate((user as any).personalityTraits,  PERSONALITY_TRAIT_FACET_MAP,  raw, 'personalityTrait')
  accumulate((user as any).relationshipValues, RELATIONSHIP_VALUE_FACET_MAP, raw, 'relationshipValue')
  accumulate((user as any).lifestyleTags,      LIFESTYLE_TAG_FACET_MAP,      raw, 'lifestyleTag')
  accumulate((user as any).loveLangGive,       LOVE_LANG_GIVE_FACET_MAP,     raw, 'loveLangGive')
  accumulate((user as any).loveLangReceive,    LOVE_LANG_RECEIVE_FACET_MAP,  raw, 'loveLangReceive')
  accumulate((user as any).weekendVibes,       WEEKEND_VIBE_FACET_MAP,       raw, 'weekendVibe')
  accumulate((user as any).habitTags,          HABIT_TAG_FACET_MAP,          raw, 'habitTag')
  accumulateSingle(user.conflictStyle,     CONFLICT_STYLE_FACET_MAP,     raw, 'conflictStyle')
  accumulateSingle(user.togethernessStyle, TOGETHERNESS_STYLE_FACET_MAP, raw, 'togethernessStyle')
  accumulateSingle(user.stressResponse,    STRESS_RESPONSE_FACET_MAP,    raw, 'stressResponse')
  accumulateSingle(user.parentalCurrent,   PARENTAL_CURRENT_FACET_MAP,   raw, 'parentalCurrent')
  accumulateSingle(user.parentalIntent,    PARENTAL_INTENT_FACET_MAP,    raw, 'parentalIntent')

  // Shadow facet adjustments — "what you reject informs who you are".
  // Conditional shadows (wants_kids, different_religion) are resolved against
  // the user's own context here; see traitToFacetMap.ts for the branching.
  const dealbreakers = (user as any).dealbreakers
  if (Array.isArray(dealbreakers) && dealbreakers.length > 0) {
    const ctx = buildShadowContext(user)
    for (const dealbreaker of dealbreakers) {
      const shadow = DEALBREAKER_SHADOW_FACETS[dealbreaker as keyof typeof DEALBREAKER_SHADOW_FACETS]
      if (!shadow) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          console.warn(`[facetProfile] unmapped dealbreaker shadow: "${dealbreaker}"`)
        }
        continue
      }
      const contributions = resolveShadowFacets(shadow, ctx)
      for (const { facet, weight } of contributions) {
        raw[facet] = (raw[facet] ?? 0) + weight
      }
    }
  }

  // Normalize each raw accumulation into [0, 1] facet space.
  const vector: Record<string, number> = {}
  for (const facetId of ALL_FACET_IDS) {
    vector[facetId] = normalize(raw[facetId] ?? 0, SCALE)
  }

  return vector as FacetVector
}
