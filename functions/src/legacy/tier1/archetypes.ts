// src/constants/archetypes.ts
//
// Archetype classification — Tier 1 design doc Sections 8.4, 8.5, 9.
//
// An archetype is a named pattern detected in a pair's facet vectors
// (Spark) or narrower facet set (Play). Each archetype has a predicate
// returning a [0, 1] confidence value. The matcher thresholds at 0.7
// (doc Section 8.5). Priority order in each array = specificity
// precedence — first predicate that clears 0.7 wins.
//
// Facet value convention (from facetProfile.ts): normalized to [0, 1]
// with 0.5 as neutral/no-data origin. "High" = >= 0.65. "Low" = <= 0.35.

import type { FacetVector } from './facetProfile'

// ─── Types ────────────────────────────────────────────────────────────

export interface ArchetypeMatch {
  id:         string
  label:      string
  copy:       string
  confidence: number
}

export interface SparkArchetypeDef {
  id:    string
  label: string
  copy:  string
  /**
   * Returns predicate-strength confidence in [0, 1]. Matcher thresholds
   * at 0.7. A return value of 0 means "this pattern does not apply".
   */
  predicate: (a: FacetVector, b: FacetVector) => number
}

export interface PlayArchetypeDef {
  id:    string
  label: string
  copy:  string
  predicate: (a: FacetVector, b: FacetVector, spiceAligned: boolean) => number
}

export interface UnlikelyFitDef {
  id:    'unlikely_fit'
  label: string
  copy:  string
  predicate: (
    a: FacetVector,
    b: FacetVector,
    finalScore: number,
    hasDealbreakerPenalty: boolean,
  ) => number
}

// ─── Threshold constants ──────────────────────────────────────────────

const HIGH_THRESHOLD = 0.55 // both users show genuine positive signal (calibrated down from 0.65)
const LOW_THRESHOLD  = 0.45 // both users show suppression (calibrated up from 0.35)

// ─── Helpers (private) ────────────────────────────────────────────────

type FKey = keyof FacetVector

const bothHigh = (a: FacetVector, b: FacetVector, k: FKey): boolean =>
  (a[k] ?? 0.5) >= HIGH_THRESHOLD && (b[k] ?? 0.5) >= HIGH_THRESHOLD

const bothLow = (a: FacetVector, b: FacetVector, k: FKey): boolean =>
  (a[k] ?? 0.5) <= LOW_THRESHOLD && (b[k] ?? 0.5) <= LOW_THRESHOLD

const diff = (a: FacetVector, b: FacetVector, k: FKey): number =>
  Math.abs((a[k] ?? 0.5) - (b[k] ?? 0.5))

/**
 * Positive-direction signal strength of a facet value in [0, 1] space.
 * Returns 0 at or below neutral (0.5), up to 0.5 at maximum (1.0).
 */
const highSignal = (v: number): number => Math.max(0, v - 0.5)

/**
 * Negative-direction signal strength — mirror of highSignal.
 * 0 at or above neutral, up to 0.5 at minimum (0.0).
 */
const lowSignal = (v: number): number => Math.max(0, 0.5 - v)

/**
 * Average bidirectional signal strength across a set of facets, given a
 * per-value signal function. Returns strength in [0, 0.5].
 */
const avgSignal = (
  a: FacetVector,
  b: FacetVector,
  facets: FKey[],
  signalFn: (v: number) => number,
): number => {
  if (facets.length === 0) return 0
  let total = 0
  for (const k of facets) {
    total += (signalFn(a[k] ?? 0.5) + signalFn(b[k] ?? 0.5)) / 2
  }
  return total / facets.length
}

/**
 * Strength [0, 0.5] → confidence [0, 1]. Minimum-passing case (strength
 * 0.15, both users at 0.65) yields confidence 0.75 — safely above the
 * 0.7 firing threshold. Strong matches (strength 0.20+) clamp to 1.0.
 */
const confidenceFromSignal = (strength: number): number =>
  Math.min(1, strength / 0.20)

// Values cluster (doc Section 2, Cluster F)
const VALUES_CLUSTER: FKey[] = [
  'integrity_valued',
  'spiritual_openness',
  'social_consciousness',
  'tradition_valued',
  'personal_growth_focus',
]

/**
 * Fraction of values-cluster facets where A and B are within `threshold`
 * of each other. Returns [0, 1].
 */
const valuesClusterAligned = (
  a: FacetVector,
  b: FacetVector,
  threshold = 0.20,
): number => {
  let aligned = 0
  for (const k of VALUES_CLUSTER) {
    if (diff(a, b, k) <= threshold) aligned++
  }
  return aligned / VALUES_CLUSTER.length
}

// ─── Spark archetypes (priority order — most specific first) ─────────

export const SPARK_ARCHETYPES: SparkArchetypeDef[] = [
  {
    id:    'the_builders',
    label: 'The Builders',
    copy:  'Two people who know what they want and how to build it. This is partnership as architecture.',
    predicate: (a, b) => {
      const required: FKey[] = [
        'ambition_drive',
        'conscientiousness',
        'family_orientation',
        'commitment_orientation',
      ]
      if (!required.every((k) => bothHigh(a, b, k))) return 0
      return confidenceFromSignal(avgSignal(a, b, required, highSignal))
    },
  },

  {
    id:    'grounded_and_free',
    label: 'Grounded & Free',
    copy:  'One of you brings the roots, one brings the wings. Unusual balance, when it works it really works.',
    predicate: (a, b) => {
      const groundedA =
        (a.routine_preference ?? 0.5) >= HIGH_THRESHOLD &&
        (a.lifestyle_discipline ?? 0.5) >= HIGH_THRESHOLD
      const freeA =
        (a.openness_to_novelty ?? 0.5) >= HIGH_THRESHOLD &&
        (a.spontaneity ?? 0.5) >= HIGH_THRESHOLD
      const groundedB =
        (b.routine_preference ?? 0.5) >= HIGH_THRESHOLD &&
        (b.lifestyle_discipline ?? 0.5) >= HIGH_THRESHOLD
      const freeB =
        (b.openness_to_novelty ?? 0.5) >= HIGH_THRESHOLD &&
        (b.spontaneity ?? 0.5) >= HIGH_THRESHOLD

      // Mutual exclusivity: one side expresses ONLY grounded, the other ONLY free.
      // If both users score high on both dimensions the archetype doesn't apply —
      // that pattern is closer to Parallel Paths or Two Peas, not this one.
      const aIsGroundedOnly = groundedA && !freeA
      const bIsGroundedOnly = groundedB && !freeB
      const aIsFreeOnly     = freeA && !groundedA
      const bIsFreeOnly     = freeB && !groundedB
      const inverseMatch = (aIsGroundedOnly && bIsFreeOnly) || (bIsGroundedOnly && aIsFreeOnly)
      if (!inverseMatch) return 0

      // Values cluster must largely align for this to be a real pattern,
      // not just a random opposite-style pair.
      const valuesFrac = valuesClusterAligned(a, b, 0.25)
      if (valuesFrac < 0.6) return 0

      // Confidence is values-alignment-driven; style inversion is the gate.
      return Math.min(1, valuesFrac)
    },
  },

  {
    id:    'kinetic_match',
    label: 'Kinetic Match',
    copy:  "Good luck keeping up with each other. You'll either burn each other out or build something loud and alive.",
    predicate: (a, b) => {
      const required: FKey[] = [
        'extraversion_social',
        'high_arousal_preference',
        'openness_to_novelty',
        'spontaneity',
      ]
      if (!required.every((k) => bothHigh(a, b, k))) return 0
      return confidenceFromSignal(avgSignal(a, b, required, highSignal))
    },
  },

  {
    id:    'quiet_depth',
    label: 'Quiet Depth',
    copy:  "Neither of you will ever have to explain why you'd rather stay in. Deep water, slow current.",
    predicate: (a, b) => {
      // Both introverted (inverse signal on extraversion_social)
      // AND both high on emotional depth + self-awareness
      if (!bothLow(a, b, 'extraversion_social')) return 0
      if (!bothHigh(a, b, 'emotional_depth')) return 0
      if (!bothHigh(a, b, 'self_awareness')) return 0

      // Combined strength: average of introversion + both depth signals.
      const introvertStrength = avgSignal(a, b, ['extraversion_social'], lowSignal)
      const depthStrength     = avgSignal(
        a, b, ['emotional_depth', 'self_awareness'], highSignal,
      )
      const combinedStrength  = (introvertStrength + depthStrength * 2) / 3
      return confidenceFromSignal(combinedStrength)
    },
  },

  {
    id:    'parallel_paths',
    label: 'Parallel Paths',
    copy:  "Two people on a clear path, moving in the same direction. You'll grow alongside, not around, each other.",
    predicate: (a, b) => {
      const required: FKey[] = [
        'personal_growth_focus',
        'ambition_drive',
        'self_awareness',
      ]
      if (!required.every((k) => bothHigh(a, b, k))) return 0
      return confidenceFromSignal(avgSignal(a, b, required, highSignal))
    },
  },

  {
    id:    'complementary_yin_yang',
    label: 'Complementary Yin/Yang',
    copy:  'Few commonalities on paper, but the ways you differ tend to create something epic. Aligned where it counts, complementary where it matters.',
    predicate: (a, b) => {
      // Values cluster tightly aligned (80%+ of values facets within 0.25)
      const valuesFrac = valuesClusterAligned(a, b, 0.25)
      if (valuesFrac < 0.8) return 0

      // Style facets diverge by > 0.35 on at least 2 of 3
      const styleFacets: FKey[] = [
        'extraversion_social',
        'risk_tolerance',
        'conflict_directness',
      ]
      const diverged = styleFacets.filter((k) => diff(a, b, k) > 0.25).length
      if (diverged < 2) return 0

      // Confidence = blended values-alignment and divergence ratio
      const divergedFrac = diverged / styleFacets.length
      return Math.min(1, (valuesFrac + divergedFrac) / 1.6)
    },
  },

  {
    id:    'two_peas',
    label: 'Two Peas in a Pod',
    copy:  'You two speak the same language. Shared wavelength, aligned values, similar rhythms.',
    predicate: (a, b) => {
      // "Same language" requires shared ACTIVE signal — not mutual
      // neutrality. Two users with all-neutral vectors aren't "two
      // peas," they're both mute. Enforce both users individually
      // engaged (>= 8 non-neutral facets) AND overall closeness AND
      // shared values activity.
      const allFacets = Object.keys(a) as FKey[]
      if (allFacets.length === 0) return 0

      const active = (v: number) => Math.abs(v - 0.5) >= 0.15
      let aActive = 0
      let bActive = 0
      for (const k of allFacets) {
        if (active(a[k] ?? 0.5)) aActive++
        if (active(b[k] ?? 0.5)) bActive++
      }
      // Each user needs meaningful signal on at least a quarter of
      // facets (8 of 32). Catches the all-neutral and barely-filled
      // cases.
      if (aActive < 8 || bActive < 8) return 0

      let within = 0
      for (const k of allFacets) {
        if (diff(a, b, k) <= 0.15) within++
      }
      const fraction = within / allFacets.length
      if (fraction < 0.7) return 0

      // Values cluster especially tight (within 0.15), measured
      // only where both users are active so "both-neutral" doesn't
      // count as alignment.
      let valuesActive = 0
      for (const k of VALUES_CLUSTER) {
        const av = a[k] ?? 0.5
        const bv = b[k] ?? 0.5
        if (active(av) && active(bv) && diff(a, b, k) <= 0.15) valuesActive++
      }
      const valuesFrac = valuesActive / VALUES_CLUSTER.length
      if (valuesFrac < 0.4) return 0

      return Math.min(1, (fraction + valuesFrac) / 1.7)
    },
  },
]

// ─── Unlikely Fit (evaluated post-score, separately) ─────────────────

export const UNLIKELY_FIT: UnlikelyFitDef = {
  id:    'unlikely_fit',
  label: 'The Unlikely Fit',
  copy:  "Statistically, this one's a surprise. Worth the conversation — the best stories start this way.",
  predicate: (_a, _b, _finalScore, _hasDealbreakerPenalty) => {
    // TODO Phase 6: tune band against shadow-week distribution or refactor
    // to percentile-based annotation at feed level. Deferred because
    // scorePair output range (0-300+) makes the doc's 45-65% threshold
    // meaningless as a raw number.
    return 0
  },
}

// ─── Play archetypes (priority order) ────────────────────────────────

export const PLAY_ARCHETYPES: PlayArchetypeDef[] = [
  {
    id:    'intense_pair',
    label: 'Intense Pair',
    copy:  'Both running hot. High-intensity chemistry from the start.',
    predicate: (a, b, spiceAligned) => {
      if (!spiceAligned) return 0
      const required: FKey[] = ['sensuality', 'physical_expressiveness']
      if (!required.every((k) => bothHigh(a, b, k))) return 0
      return confidenceFromSignal(avgSignal(a, b, required, highSignal))
    },
  },

  {
    id:    'talkers_first',
    label: 'Talkers First',
    copy:  'Both the type to discuss before diving in. Clear expectations, honored agreements.',
    predicate: (a, b) => {
      const required: FKey[] = [
        'conflict_directness',
        'verbal_expressiveness',
        'integrity_valued',
      ]
      if (!required.every((k) => bothHigh(a, b, k))) return 0
      return confidenceFromSignal(avgSignal(a, b, required, highSignal))
    },
  },

  {
    id:    'same_frequency',
    label: 'Same Frequency',
    copy:  "Aligned on all the dimensions that count here. You're reading the same map.",
    predicate: (a, b, spiceAligned) => {
      if (!spiceAligned) return 0
      const playFacets: FKey[] = [
        'sensuality',
        'physical_expressiveness',
        'high_arousal_preference',
        'spontaneity',
        'playfulness',
      ]
      let aligned = 0
      for (const k of playFacets) {
        if (diff(a, b, k) <= 0.20) aligned++
      }
      const fraction = aligned / playFacets.length
      if (fraction < 0.8) return 0
      return Math.min(1, fraction)
    },
  },

  {
    id:    'curious_and_willing',
    label: 'Curious & Willing',
    copy:  'One or both of you exploring. Moderate alignment, plenty of room to discover.',
    predicate: (a, b) => {
      const playFacets: FKey[] = [
        'sensuality',
        'physical_expressiveness',
        'high_arousal_preference',
        'spontaneity',
        'playfulness',
      ]
      let aligned = 0
      for (const k of playFacets) {
        if (diff(a, b, k) <= 0.35) aligned++
      }
      const fraction = aligned / playFacets.length
      // Fires for "some alignment" but not "everything aligned" (the
      // latter would be Same Frequency or Intense Pair).
      if (fraction < 0.5 || fraction >= 0.8) return 0
      return Math.min(1, fraction / 0.7)
    },
  },
]
