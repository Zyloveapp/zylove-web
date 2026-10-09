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
  MIN_CONFIDENCE,
  type ArchetypeMatch,
} from './archetypes'

// Below this a pattern isn't clear enough to name (was 0.4; the header
// said 0.7). The app shows a neutral line instead.
const CONFIDENCE_THRESHOLD = MIN_CONFIDENCE

/**
 * The strongest fit wins. Each predicate returns a confidence in [0, 1]; the
 * highest at or above CONFIDENCE_THRESHOLD wins, and a tie goes to the
 * earlier (more specific) entry in `defs`. Null when nothing is clear.
 */
export function pickStrongest<D extends { id: string; label: string; copy: string }>(
  defs: D[],
  confidenceOf: (def: D) => number,
): ArchetypeMatch | null {
  let best: ArchetypeMatch | null = null
  for (const def of defs) {
    const confidence = confidenceOf(def)
    if (confidence >= CONFIDENCE_THRESHOLD && (!best || confidence > best.confidence)) {
      best = { id: def.id, label: def.label, copy: def.copy, confidence }
    }
  }
  return best
}

/**
 * Returns the strongest Spark archetype per design doc Section 8.4, or
 * null if none is clear (see pickStrongest).
 *
 * Unlikely Fit is evaluated separately via matchUnlikelyFit since it
 * depends on final score and dealbreaker state, not just facets.
 */
export function matchSparkArchetype(
  a: FacetVector,
  b: FacetVector,
): ArchetypeMatch | null {
  return pickStrongest(SPARK_ARCHETYPES, (arch) => arch.predicate(a, b))
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
 * Strongest fit wins, like Spark (it was first-match-wins).
 * `spiceAligned` comes from existing Play scoring in scorePlayPair —
 * passed in rather than recomputed.
 */
export function matchPlayArchetype(
  a: FacetVector,
  b: FacetVector,
  spiceAligned: boolean,
): ArchetypeMatch | null {
  return pickStrongest(PLAY_ARCHETYPES, (arch) => arch.predicate(a, b, spiceAligned))
}
