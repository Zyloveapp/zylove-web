// src/services/archetypeMatcher.ts
//
// Archetype classification service — Tier 1 design doc Sections 8.4, 8.5, 9.
// Pure functions, no I/O. Callers pass in the facet vectors (from
// computeFacetProfile) and receive the best-matching archetype or null.

import type { FacetVector } from './facetProfile'
import {
  SPARK_ARCHETYPES,
  PLAY_ARCHETYPES,
  UNLIKELY_FIT,
  type ArchetypeMatch,
} from './archetypes'

const CONFIDENCE_THRESHOLD = 0.4

/**
 * Returns the best-matching Spark archetype per design doc Section 8.4,
 * or null if no archetype clears the 0.7 confidence threshold. Priority
 * order = specificity precedence (see SPARK_ARCHETYPES declaration order).
 *
 * Unlikely Fit is evaluated separately via matchUnlikelyFit since it
 * depends on final score and dealbreaker state, not just facets.
 */
export function matchSparkArchetype(
  a: FacetVector,
  b: FacetVector,
): ArchetypeMatch | null {
  let best: ArchetypeMatch | null = null
  for (const arch of SPARK_ARCHETYPES) {
    const confidence = arch.predicate(a, b)
    if (confidence >= CONFIDENCE_THRESHOLD && (!best || confidence > best.confidence)) {
      best = {
        id:         arch.id,
        label:      arch.label,
        copy:       arch.copy,
        confidence,
      }
    }
  }
  return best
}

/**
 * Evaluated after scoring. Currently always returns null — the predicate
 * is stubbed pending Phase 6 threshold calibration against production
 * scorePair output distribution. See UNLIKELY_FIT.predicate TODO.
 *
 * Call site preserved so the fallback chain is wired and ready to light
 * up when the predicate is tuned.
 */
export function matchUnlikelyFit(
  a: FacetVector,
  b: FacetVector,
  finalScore: number,
  hasDealbreakerPenalty: boolean,
): ArchetypeMatch | null {
  const confidence = UNLIKELY_FIT.predicate(
    a,
    b,
    finalScore,
    hasDealbreakerPenalty,
  )
  if (confidence >= CONFIDENCE_THRESHOLD) {
    return {
      id:         UNLIKELY_FIT.id,
      label:      UNLIKELY_FIT.label,
      copy:       UNLIKELY_FIT.copy,
      confidence,
    }
  }
  return null
}

/**
 * Play archetype matching per design doc Section 9. Narrower facet set.
 * `spiceAligned` comes from existing Play scoring in scorePlayPair —
 * passed in rather than recomputed.
 */
export function matchPlayArchetype(
  a: FacetVector,
  b: FacetVector,
  spiceAligned: boolean,
): ArchetypeMatch | null {
  for (const arch of PLAY_ARCHETYPES) {
    const confidence = arch.predicate(a, b, spiceAligned)
    if (confidence >= CONFIDENCE_THRESHOLD) {
      return {
        id:         arch.id,
        label:      arch.label,
        copy:       arch.copy,
        confidence,
      }
    }
  }
  return null
}
