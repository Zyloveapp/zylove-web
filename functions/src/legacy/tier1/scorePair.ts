// src/services/scorePair.ts
//
// Zylove pair compatibility scoring — asymmetric (bidirectional) engine.
// This is the heart of Tier 1 matching: given two users + their facet vectors,
// produces scoreAB (how well B fits A) and scoreBA (how well A fits B) plus
// a combined metric for post-match display.
//
// Architectural philosophy
// ────────────────────────
// Scoring is ASYMMETRIC. Pre-match, each user sees their own directional score
// for the other. Post-match reveal shows both sides plus a weighted-toward-minimum
// combined score, reflecting relationship reality: the less-invested side limits
// mutual growth, but strong pull on one side still contributes.
//
// Over-100% scores are POSSIBLE and NOT CLAMPED. Option-C physical amplification
// (3× / 2× / 1.5× multiplier on physical component when viewer's stated criteria
// are fully/mostly/partly satisfied) stacks with exceptional facet alignment
// and zero dealbreakers to push scoreAB above 100. UI must handle three-digit
// rendering — flagged for later UI work, not File 4's concern.
//
// Hard-zero behavior: ONLY orientation/attraction mismatch zeros the score.
// Physical preference mismatch applies a minor deduction (max 0.1), never
// craters. Dealbreaker triggers are soft repulsions — 0.2 multiplier per
// trigger on the psychological component, preserving physical + intent
// contributions (so a single dealbreaker-triggered pair shows ~45% ceiling,
// not zero).
//
// Combined score math
// ───────────────────
// combinedScore = 0.4 * max(scoreAB, scoreBA) + 0.6 * min(scoreAB, scoreBA)
// Example: A→B 95, B→A 73 → 0.4×95 + 0.6×73 = 38 + 43.8 = 81.8 ≈ 82
//
// Dependencies
// ────────────
//   - src/constants/facets.ts           (FacetId, ALL_FACET_IDS)
//   - src/constants/traitToFacetMap.ts  (DEALBREAKER_REPULSION_MAP)
//   - src/services/facetProfile.ts      (FacetVector)
//   - src/types/profile.ts              (DatingProfile, Dealbreaker)
//
// Math source: Tier 1 design doc v2, Sections 1.2, 6.1-6.3, 8.1-8.3.
// Legacy physical/intent helpers copied from src/services/compatibility.ts
// rather than imported — legacy file is being phased out.

import type { FacetId } from './facets'
import { ALL_FACET_IDS } from './facets'
import {
  DEALBREAKER_REPULSION_MAP,
  type DealbreakerRepulsion,
} from './traitToFacetMap'
import type { FacetVector } from './facetProfile'
import type { DatingProfile, Dealbreaker } from '../types'
import { matchSparkArchetype, matchUnlikelyFit } from './archetypeMatcher'
import type { ArchetypeMatch } from './archetypes'

// ─── Public types ─────────────────────────────────────────────────────────

export interface PairScoreResult {
  // A→B asymmetric score — how well B fits A's preferences + values
  scoreAB:                 number
  baseScoreAB:             number
  physicalScoreAB:         number
  intentScoreAB:           number
  dealbreakerMultiplierAB: number
  triggeredDealbreakersAB: string[]
  facetScoresAB:           Record<FacetId, number>

  // B→A asymmetric score — how well A fits B's preferences + values
  scoreBA:                 number
  baseScoreBA:             number
  physicalScoreBA:         number
  intentScoreBA:           number
  dealbreakerMultiplierBA: number
  triggeredDealbreakersBA: string[]
  facetScoresBA:           Record<FacetId, number>

  // Combined metric for post-match reveal
  combinedScore:           number

  // For archetype classifier (File 5) — direct asymmetry inspection
  asymmetryData: {
    userAScoresUserB: number
    userBScoresUserA: number
    gap:              number
    weightedMin:      number
  }

  // Forward-looking hook — min data completeness across both users
  dataConfidence:          number

  // Phase 4 — best-matching archetype for this pair, or null if no
  // pattern clears the 0.7 confidence threshold. Nothing consumes this
  // yet; Phase 6 UI will. See src/constants/archetypes.ts.
  archetype:               ArchetypeMatch | null
}

// ─── Scoring constants ────────────────────────────────────────────────────

const HIGH_WEIGHT = 0.10
const MED_WEIGHT  = 0.04
const LOW_WEIGHT  = 0.008

const HIGH_WEIGHT_FACETS = new Set<FacetId>([
  'emotional_stability',
  'emotional_depth',
  'emotional_availability',
  'integrity_valued',
  'commitment_orientation',
  'self_awareness',
])

const MED_WEIGHT_FACETS = new Set<FacetId>([
  'personal_growth_focus',
  'lifestyle_discipline',
  'family_orientation',
  'nurturing_impulse',
  'conflict_directness',
  'intellectual_curiosity',
])

// 21 facets that use similarity scoring (values, emotional signatures, shared aesthetics).
// Everything else uses complementarity scoring (style/pace/energy facets).
const SIMILARITY_FACETS = new Set<FacetId>([
  // Cluster A
  'intellectual_curiosity', 'aesthetic_sensitivity',
  // Cluster C
  'emotional_stability', 'emotional_depth', 'self_awareness',
  // Cluster D
  'conscientiousness', 'lifestyle_discipline', 'ambition_drive',
  // Cluster E
  'emotional_availability', 'commitment_orientation', 'nurturing_impulse',
  'partnership_egalitarianism', 'family_orientation',
  // Cluster F (all 5)
  'integrity_valued', 'spiritual_openness', 'social_consciousness',
  'tradition_valued', 'personal_growth_focus',
  // Cluster G
  'playfulness', 'sensuality', 'physical_expressiveness',
])

// Optimal gap for complementarity-allowed facets. Peak at 0.3 means best match
// is when partners differ by ~30% on introversion/spontaneity/risk/conflict style.
const COMPLEMENTARITY_OPTIMAL_GAP = 0.3

// Composed formula weights from design doc Section 8.3
const W_PSYCHOLOGICAL = 0.55
const W_PHYSICAL      = 0.15
const W_INTENT        = 0.30

// Each triggered dealbreaker multiplies the psychological component by this.
// 1 triggered = 0.2, 2 triggered = 0.04, none = 1.0 (no repulsion).
const DEALBREAKER_PENALTY_PER_TRIGGER = 0.2

// Combined score blend: 40% to the higher side, 60% to the lower side.
// Reflects that the less-invested partner limits mutual growth while still
// honoring that strong pull on one side contributes something.
const COMBINED_WEIGHT_MAX = 0.4
const COMBINED_WEIGHT_MIN = 0.6

// ─── Validation ───────────────────────────────────────────────────────────

function validateFacetVector(vector: FacetVector, name: string): void {
  for (const id of ALL_FACET_IDS) {
    const value = vector[id]
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(
        `[computePairScore] ${name} is malformed: missing or invalid facet "${id}" ` +
        `(got ${typeof value})`,
      )
    }
  }
}

// ─── Intent / attraction helpers (copied from legacy compatibility.ts) ────

function exactMatch(a: unknown, b: unknown): number {
  if (a == null || b == null) return 0.5
  return a === b ? 1 : 0
}

function ageCompatibility(a: any, b: any): number {
  const aMin = a?.ageMin ?? 18
  const aMax = a?.ageMax ?? 99
  const bMin = b?.ageMin ?? 18
  const bMax = b?.ageMax ?? 99
  const aWantsB = b?.age >= aMin && b?.age <= aMax
  const bWantsA = a?.age >= bMin && a?.age <= bMax
  if (aWantsB && bWantsA) return 1
  if (aWantsB || bWantsA) return 0.5
  return 0
}

// Canonical form: strip all non-alphanumeric chars, lowercase. Handles
// underscore/hyphen/space/case variations across enum values and legacy writes
// (e.g. 'trans_man', 'trans man', 'Trans Man' all normalize to 'transman').
function canonical(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : ''
}

// Audit-friendly map: "attractedTo value X accepts gender values [Y, Z, ...]".
// '*' = wildcard (everyone). Binary men/women match their category and the
// matching trans identity. nonbinarypeople matches off-binary identities but
// NOT binary men/women — off-binary users who want binary matching declare it
// via `matchableAs` (see prefMatchesGender below).
const ATTRACTED_TO_MATCHES: Record<string, readonly string[]> = {
  men:             ['man', 'transman'],
  women:           ['woman', 'transwoman'],
  nonbinarypeople: ['nonbinary', 'genderfluid', 'agender', 'selfdescribe'],
  transmen:        ['transman'],
  transwomen:      ['transwoman'],
  everyone:        ['*'],
}

// Off-map identities explicitly declare their matching categories via
// `matchableAs` during onboarding (Item 3 of orientation fixes).
const OFF_MAP_IDENTITIES = new Set(['genderfluid', 'agender', 'selfdescribe'])

// prefMatchesGender: does viewer preference `pref` accept target `gender`?
// Defensive against array-typed gender (Play multi-select), non-string values,
// undefined, and underscore/hyphen/space variations. `matchableAs` is consulted
// only when the target is an off-map identity.
function prefMatchesGender(pref: unknown, gender: unknown, matchableAs?: unknown): boolean {
  const prefKey = canonical(pref)
  if (!prefKey) return false
  const rule = ATTRACTED_TO_MATCHES[prefKey]
  if (!rule) return false
  if (rule.includes('*')) return true

  const genders = (Array.isArray(gender) ? gender : [gender]).map(canonical).filter(Boolean)
  if (!genders.length) return false
  if (genders.some(g => rule.includes(g))) return true

  // Off-map identities: consult the target's declared `matchableAs`.
  const hasOffMap = genders.some(g => OFF_MAP_IDENTITIES.has(g))
  if (hasOffMap && Array.isArray(matchableAs)) {
    for (const m of matchableAs) {
      const mKey = canonical(m)
      if (mKey === prefKey || mKey === 'everyone') return true
    }
  }
  return false
}

// Hard-zero on any one-way orientation rejection. If either side's stated
// attraction does not include the other's gender, they should never match —
// regardless of whoever's more flexible. Only mutual yes returns 1.
function attractionCompatibility(a: any, b: any): number {
  const aAttr = Array.isArray(a?.attractedTo) ? a.attractedTo : []
  const bAttr = Array.isArray(b?.attractedTo) ? b.attractedTo : []
  const aAttractedToB = aAttr.some((pref: unknown) =>
    prefMatchesGender(pref, b?.genderIdentity, b?.matchableAs))
  const bAttractedToA = bAttr.some((pref: unknown) =>
    prefMatchesGender(pref, a?.genderIdentity, a?.matchableAs))
  if (aAttractedToB && bAttractedToA) return 1
  return 0
}

// intentScore blends the three similarity-required signals: declared intent
// agreement, mutual age range fit, and mutual attraction. Symmetric by
// construction — arguments commute.
function intentScore(a: DatingProfile, b: DatingProfile, attractionValue: number): number {
  const intent = exactMatch((a as any).intent, (b as any).intent)
  const age    = ageCompatibility(a, b)
  return (intent + age + attractionValue) / 3
}

// ─── Physical scoring with Option C amplification ─────────────────────────

/**
 * Computes viewer's physical score for target. Two components:
 *  - basePhysical: [0, 1] average fit across stated criteria (existing logic)
 *  - amplification: multiplier based on how many criteria were satisfied
 *
 * Criteria: height range (seekingHeightMinCm/MaxCm vs target.heightCm) and
 * body type (seekingBodyTypes vs target.bodyType). Max 2 criteria.
 *
 * Amplification tiers (per Matthew's product spec, 2-criterion world):
 *   matchRatio 1.0    → 3.0× base   (both criteria fit, can push > 1.0)
 *   matchRatio ≥ 0.5  → 2.0× base   (one of two fits)
 *   matchRatio 0      → max(0, base - 0.1)   (minor deduction, no crater)
 *   No criteria stated → 0.5 (neutral — no bonus / no penalty)
 */
function physicalScoreWithAmplification(viewer: any, target: any): number {
  const subScores: number[] = []
  let matched = 0
  let total   = 0

  // Height range
  if (
    viewer?.seekingHeightMinCm &&
    viewer?.seekingHeightMaxCm &&
    target?.heightCm
  ) {
    total++
    const inRange =
      target.heightCm >= viewer.seekingHeightMinCm &&
      target.heightCm <= viewer.seekingHeightMaxCm
    if (inRange) matched++
    subScores.push(inRange ? 1 : 0.2)
  }

  // Body type
  if (
    Array.isArray(viewer?.seekingBodyTypes) &&
    viewer.seekingBodyTypes.length > 0 &&
    target?.bodyType
  ) {
    total++
    const fits = viewer.seekingBodyTypes.includes(target.bodyType)
    if (fits) matched++
    subScores.push(fits ? 1 : 0.3)
  }

  // No criteria stated → neutral
  if (total === 0) return 0.5

  const basePhysical =
    subScores.reduce((acc, x) => acc + x, 0) / subScores.length
  const matchRatio = matched / total

  if (matchRatio === 1.0)  return basePhysical * 3.0
  if (matchRatio >= 0.5)   return basePhysical * 2.0
  return Math.max(0, basePhysical - 0.1)
}

// ─── Facet similarity / complementarity ───────────────────────────────────

function facetWeight(id: FacetId): number {
  if (HIGH_WEIGHT_FACETS.has(id)) return HIGH_WEIGHT
  if (MED_WEIGHT_FACETS.has(id))  return MED_WEIGHT
  return LOW_WEIGHT
}

// similarity: 1 - |A - B|; range [0, 1]. Peak when A == B.
// complementarity: 1 - (|A - B| - 0.3)^2; peak when gap == 0.3 (moderate diff).
function facetScoreValue(a: number, b: number, isSimilarity: boolean): number {
  const gap = Math.abs(a - b)
  if (isSimilarity) {
    return 1 - gap
  }
  const raw = 1 - Math.pow(gap - COMPLEMENTARITY_OPTIMAL_GAP, 2)
  return Math.max(0, Math.min(1, raw))
}

function computeBaseAndFacetScores(
  vectorA: FacetVector,
  vectorB: FacetVector,
): { baseScore: number; facetScores: Record<FacetId, number> } {
  const facetScores: Record<string, number> = {}
  let base = 0
  for (const id of ALL_FACET_IDS) {
    const score = facetScoreValue(vectorA[id], vectorB[id], SIMILARITY_FACETS.has(id))
    facetScores[id] = score
    base += facetWeight(id) * score
  }
  return {
    baseScore:   base,
    facetScores: facetScores as Record<FacetId, number>,
  }
}

// ─── Dealbreaker evaluation ───────────────────────────────────────────────

function checkThreshold(value: number, threshold: number, op: 'lt' | 'gt'): boolean {
  return op === 'lt' ? value < threshold : value > threshold
}

function evaluateFacetRepulsion(
  repulsion: Extract<DealbreakerRepulsion, { kind: 'facet' }>,
  targetVector: FacetVector,
): boolean {
  const primary = checkThreshold(
    targetVector[repulsion.facet],
    repulsion.threshold,
    repulsion.operator,
  )
  if (!primary) return false
  if (repulsion.compoundWith) {
    return checkThreshold(
      targetVector[repulsion.compoundWith.facet],
      repulsion.compoundWith.threshold,
      repulsion.compoundWith.operator,
    )
  }
  return true
}

// Per-dealbreaker hardFilter logic. REPULSION_MAP's 'hardFilter' entries name
// the field but not the target value(s) — that logic lives here, keyed by
// dealbreaker enum value.
function evaluateHardFilter(
  dealbreaker: Dealbreaker,
  viewer: any,
  target: any,
): boolean {
  switch (dealbreaker) {
    case 'has_kids':
      return target?.parentalStatus === 'has_kids'
    case 'wants_kids':
      return target?.parentalStatus === 'wants_kids'
    case 'doesnt_want_kids':
      return target?.parentalStatus === 'child_free'
    case 'non_exclusive':
      return (
        Array.isArray(target?.openTo) &&
        target.openTo.some(
          (o: string) => o === 'open_relationship' || o === 'casual' || o === 'polyamory',
        )
      )
    case 'different_religion': {
      const v = viewer?.religion
      const t = target?.religion
      if (!v || !t) return false
      if (v === 'prefer_not_to_say' || t === 'prefer_not_to_say') return false
      return v !== t
    }
    case 'different_politics': {
      const v = viewer?.politicalView
      const t = target?.politicalView
      if (!v || !t) return false
      if (v === 'prefer_not_to_say' || t === 'prefer_not_to_say') return false
      if (v === 'apolitical' || t === 'apolitical') return false
      return v !== t
    }
    default:
      return false
  }
}

function isDealbreakerTriggered(
  dealbreaker: Dealbreaker,
  viewer: any,
  target: any,
  targetVector: FacetVector,
): boolean {
  const repulsion = DEALBREAKER_REPULSION_MAP[dealbreaker]
  if (!repulsion) return false
  if (repulsion.kind === 'facet') {
    return evaluateFacetRepulsion(repulsion, targetVector)
  }
  return evaluateHardFilter(dealbreaker, viewer, target)
}

/**
 * Computes the dealbreaker multiplier for one direction. Each triggered
 * dealbreaker contributes a factor of DEALBREAKER_PENALTY_PER_TRIGGER (0.2);
 * multiple triggers compound multiplicatively. Returns the multiplier and the
 * list of triggered dealbreaker keys for UI display.
 */
function computeDealbreakerMultiplier(
  viewer: any,
  target: any,
  targetVector: FacetVector,
): { multiplier: number; triggered: string[] } {
  const breakers: string[] = Array.isArray(viewer?.dealbreakers) ? viewer.dealbreakers : []
  const triggered: string[] = []
  for (const d of breakers) {
    if (isDealbreakerTriggered(d as Dealbreaker, viewer, target, targetVector)) {
      triggered.push(d)
    }
  }
  const multiplier = Math.pow(DEALBREAKER_PENALTY_PER_TRIGGER, triggered.length)
  return { multiplier, triggered }
}

// ─── Data confidence ──────────────────────────────────────────────────────

function singleUserConfidence(user: any): number {
  const arrays = [
    user?.personalityTraits,
    user?.relationshipValues,
    user?.lifestyleTags,
    user?.loveLangGive,
    user?.loveLangReceive,
    user?.weekendVibes,
    user?.habitTags,
  ]
  const filled = arrays.filter(a => Array.isArray(a) && a.length > 0).length
  return filled / arrays.length
}

// ─── Combined score ───────────────────────────────────────────────────────

function combineScores(scoreAB: number, scoreBA: number): number {
  return (
    COMBINED_WEIGHT_MAX * Math.max(scoreAB, scoreBA) +
    COMBINED_WEIGHT_MIN * Math.min(scoreAB, scoreBA)
  )
}

// ─── Hard-zero result (orientation mismatch) ──────────────────────────────

function buildZeroResult(): PairScoreResult {
  const zeroFacets: Record<string, number> = {}
  for (const id of ALL_FACET_IDS) zeroFacets[id] = 0

  const zeroed = {
    scoreAB:                 0,
    baseScoreAB:             0,
    physicalScoreAB:         0,
    intentScoreAB:           0,
    dealbreakerMultiplierAB: 1,
    triggeredDealbreakersAB: [] as string[],
    facetScoresAB:           zeroFacets as Record<FacetId, number>,

    scoreBA:                 0,
    baseScoreBA:             0,
    physicalScoreBA:         0,
    intentScoreBA:           0,
    dealbreakerMultiplierBA: 1,
    triggeredDealbreakersBA: [] as string[],
    facetScoresBA:           zeroFacets as Record<FacetId, number>,

    combinedScore:           0,

    asymmetryData: {
      userAScoresUserB: 0,
      userBScoresUserA: 0,
      gap:              0,
      weightedMin:      0,
    },

    dataConfidence:          0,

    archetype:               null,
  }

  return zeroed
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Computes bidirectional compatibility scoring for a pair.
 *
 * Pure function: same inputs → same outputs, no I/O, no side effects.
 * Callers are expected to precompute each user's facet vector via
 * `computeFacetProfile(user)` and pass it in. This keeps the function
 * efficient when scoring many candidates against the same user.
 *
 * Throws if either vector is missing any of the 32 canonical facet keys —
 * malformed input is a programming error, not a data edge case.
 */
export function computePairScore(
  userA:   DatingProfile,
  userB:   DatingProfile,
  vectorA: FacetVector,
  vectorB: FacetVector,
): PairScoreResult {
  validateFacetVector(vectorA, 'vectorA')
  validateFacetVector(vectorB, 'vectorB')

  // Hard-zero case: no mutual attraction at all.
  // One-way attraction (value = 0.5) does NOT zero — it feeds intentScore as
  // a soft signal. Only bidirectional orientation incompatibility zeros.
  const attraction = attractionCompatibility(userA, userB)
  if (attraction === 0) {
    return buildZeroResult()
  }

  // Symmetric components — computed once, used in both directions.
  // Facet similarity/complementarity is commutative: facetScore(a, b) == facetScore(b, a).
  // Same for exactMatch(intent), ageCompatibility, attractionCompatibility.
  const { baseScore, facetScores } = computeBaseAndFacetScores(vectorA, vectorB)
  const intent                     = intentScore(userA, userB, attraction)

  // Asymmetric components — each direction's viewer evaluates target.
  const physicalAB = physicalScoreWithAmplification(userA, userB)
  const physicalBA = physicalScoreWithAmplification(userB, userA)
  const dbAB       = computeDealbreakerMultiplier(userA, userB, vectorB)
  const dbBA       = computeDealbreakerMultiplier(userB, userA, vectorA)

  // Composed scores per direction (×100 for UI-facing integer-ish display).
  // NOT clamped at 100 — physical amplification can legitimately push above.
  const scoreAB =
    (W_PSYCHOLOGICAL * baseScore * dbAB.multiplier +
     W_PHYSICAL      * physicalAB +
     W_INTENT        * intent) * 100

  const scoreBA =
    (W_PSYCHOLOGICAL * baseScore * dbBA.multiplier +
     W_PHYSICAL      * physicalBA +
     W_INTENT        * intent) * 100

  const combined = combineScores(scoreAB, scoreBA)

  // Archetype classification — facet-based matchers run first, Unlikely
  // Fit runs post-score as fallback. Unlikely Fit is stubbed (always
  // null) until Phase 6 calibrates its band against production score
  // distribution. The chain is wired so Phase 6 only needs to tune the
  // predicate.
  const facetArchetype = matchSparkArchetype(vectorA, vectorB)
  const hasDealbreakerPenalty =
    dbAB.multiplier < 1 || dbBA.multiplier < 1
  const archetype: ArchetypeMatch | null =
    facetArchetype ??
    matchUnlikelyFit(vectorA, vectorB, combined, hasDealbreakerPenalty)

  return {
    scoreAB,
    baseScoreAB:             baseScore,
    physicalScoreAB:         physicalAB,
    intentScoreAB:           intent,
    dealbreakerMultiplierAB: dbAB.multiplier,
    triggeredDealbreakersAB: dbAB.triggered,
    facetScoresAB:           facetScores,

    scoreBA,
    baseScoreBA:             baseScore,
    physicalScoreBA:         physicalBA,
    intentScoreBA:           intent,
    dealbreakerMultiplierBA: dbBA.multiplier,
    triggeredDealbreakersBA: dbBA.triggered,
    facetScoresBA:           facetScores,

    combinedScore:           combined,

    asymmetryData: {
      userAScoresUserB: scoreAB,
      userBScoresUserA: scoreBA,
      gap:              Math.abs(scoreAB - scoreBA),
      weightedMin:      combined,
    },

    dataConfidence: Math.min(singleUserConfidence(userA), singleUserConfidence(userB)),

    archetype,
  }
}
