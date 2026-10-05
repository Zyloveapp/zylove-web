// functions/src/scoring.ts
//
// Server-side compatibility scoring.
// Field names corrected to match actual Firestore data from onboarding.

import { UserDoc, SparkBreakdown, PlayBreakdown } from "./types";
import { computeFacetProfile } from "./tier1/facetProfile";
import { computePairScore } from "./tier1/scorePair";
import { matchPlayArchetype } from "./tier1/archetypeMatcher";
import type { DatingProfile } from "./types";

// Dealbreakers no longer contribute to the weighted Tier 0 score — they
// drive UI banners (Discover dealbreaker warning, MatchScorecard mirror)
// and the tier1Spark.combinedScore cap, but are not weighted in.
// breakdown.dealbreakers is still computed for those display surfaces.
const SPARK_WEIGHTS = {
  coreFit:          0.18,
  valuesIntentions: 0.29,
  physicalPrefs:    0.18,
  loveLanguages:    0.18,
  lifestyle:        0.11,
  personality:      0.06,
} as const;

const PLAY_WEIGHTS = {
  nonNegotiables:        0.35,
  physicalCompatibility: 0.30,
  energyVibe:            0.20,
  intentionsLimits:      0.15,
} as const;

// ─── Utilities ────────────────────────────────────────────────────────────────

function arrayOverlap(a: string[], b: string[]): number {
  if (!a?.length || !b?.length) return 0.5;
  const setA    = new Set(a);
  const matches = b.filter(x => setA.has(x)).length;
  return matches / Math.max(a.length, b.length);
}

function exactMatch(a: unknown, b: unknown): number {
  if (a == null || b == null) return 0.5;
  return a === b ? 1 : 0;
}

// ─── Field accessors ──────────────────────────────────────────────────────────

function ageCompatibility(a: any, b: any): number {
  const aMin = (a as any).ageMin ?? 18;
  const aMax = (a as any).ageMax ?? 99;
  const bMin = (b as any).ageMin ?? 18;
  const bMax = (b as any).ageMax ?? 99;
  const aWantsB = b.age >= aMin && b.age <= aMax;
  const bWantsA = a.age >= bMin && a.age <= bMax;
  if (aWantsB && bWantsA) return 1;
  if (aWantsB || bWantsA) return 0.5;
  return 0;
}

// Canonical form: strip non-alphanumeric, lowercase. Handles underscore /
// hyphen / space / case variations from enum values and legacy writes.
function canonical(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

// Audit-friendly: "attractedTo value X accepts gender values [Y, Z, ...]".
// '*' = wildcard. nonbinarypeople matches off-binary only; off-binary users
// reach the binary pool via `matchableAs` declared during onboarding.
const ATTRACTED_TO_MATCHES: Record<string, readonly string[]> = {
  men:             ['man', 'transman'],
  women:           ['woman', 'transwoman'],
  nonbinarypeople: ['nonbinary', 'genderfluid', 'agender', 'selfdescribe'],
  transmen:        ['transman'],
  transwomen:      ['transwoman'],
  everyone:        ['*'],
};

const OFF_MAP_IDENTITIES = new Set(['genderfluid', 'agender', 'selfdescribe']);

// Defensive against: undefined/null inputs, array-typed gender (Play mode),
// non-string values, and underscore/hyphen/space variations.
function prefMatchesGender(pref: unknown, gender: unknown, matchableAs?: unknown): boolean {
  const prefKey = canonical(pref);
  if (!prefKey) return false;
  const rule = ATTRACTED_TO_MATCHES[prefKey];
  if (!rule) return false;
  if (rule.includes('*')) return true;

  const genders = (Array.isArray(gender) ? gender : [gender]).map(canonical).filter(Boolean);
  if (!genders.length) return false;
  if (genders.some(g => rule.includes(g))) return true;

  const hasOffMap = genders.some(g => OFF_MAP_IDENTITIES.has(g));
  if (hasOffMap && Array.isArray(matchableAs)) {
    for (const m of matchableAs) {
      const mKey = canonical(m);
      if (mKey === prefKey || mKey === 'everyone') return true;
    }
  }
  return false;
}

// Hard-zero on any one-way orientation rejection. Only mutual yes returns 1.
function attractionCompatibility(a: any, b: any): number {
  const aAttr = Array.isArray((a as any)?.attractedTo) ? (a as any).attractedTo : [];
  const bAttr = Array.isArray((b as any)?.attractedTo) ? (b as any).attractedTo : [];
  const aAttractedToB = aAttr.some((pref: unknown) =>
    prefMatchesGender(pref, (b as any)?.genderIdentity, (b as any)?.matchableAs));
  const bAttractedToA = bAttr.some((pref: unknown) =>
    prefMatchesGender(pref, (a as any)?.genderIdentity, (a as any)?.matchableAs));
  if (aAttractedToB && bAttractedToA) return 1;
  return 0;
}

function physicalPrefScore(a: any, b: any): number {
  const scores: number[] = [];
  if ((a as any).seekingHeightMinCm && (a as any).seekingHeightMaxCm && (b as any).heightCm) {
    const inRange = (b as any).heightCm >= (a as any).seekingHeightMinCm &&
                    (b as any).heightCm <= (a as any).seekingHeightMaxCm;
    scores.push(inRange ? 1 : 0.2);
  }
  if ((a as any).seekingBodyTypes?.length && (b as any).bodyType) {
    scores.push((a as any).seekingBodyTypes.includes((b as any).bodyType) ? 1 : 0.3);
  }
  if (!scores.length) return 0.5;
  return scores.reduce((x, y) => x + y, 0) / scores.length;
}

// Evaluates whether `breaker` is triggered by `partner`'s profile. `self` is
// only consulted for "different_*" dealbreakers that require comparing sides.
// All 9 enum values are evaluable here; unknown values (e.g. stale Firestore
// writes from the old 13-value enum) hit the default branch and silently no-op.
function isDealbreakerTriggered(breaker: string, partner: any, self: any): boolean {
  switch (breaker) {
    case 'cigarette_smoker':
      return Array.isArray(partner?.habitTags) && partner.habitTags.includes('cigarette_smoker');
    case 'vaper':
      return Array.isArray(partner?.habitTags) && partner.habitTags.includes('vaper');
    case 'heavy_drinker':
      return partner?.drinkingHabit === 'regularly';
    case 'has_kids':
    case 'partner_has_kids':
      return partner?.parentalStatus === 'has_kids'
          || partner?.parentalCurrent === 'has_kids';
    case 'wants_kids':
    case 'partner_wants_kids':
      return partner?.parentalStatus === 'wants_kids'
          || partner?.parentalIntent === 'wants_first'
          || partner?.parentalIntent === 'wants_more';
    case 'doesnt_want_kids':
    case 'partner_doesnt_want_kids':
      return partner?.parentalStatus === 'child_free'
          || partner?.parentalIntent === 'doesnt_want_any'
          || partner?.parentalIntent === 'doesnt_want_more';
    case 'non_exclusive':
      return Array.isArray(partner?.openTo) &&
        partner.openTo.some((o: string) => o === 'open_relationship' || o === 'casual' || o === 'polyamory');
    case 'different_religion': {
      const s = self?.religion;
      const p = partner?.religion;
      if (!s || !p) return false;
      if (s === 'prefer_not_to_say' || p === 'prefer_not_to_say') return false;
      return s !== p;
    }
    case 'different_politics': {
      const s = self?.politicalView;
      const p = partner?.politicalView;
      if (!s || !p) return false;
      if (s === 'prefer_not_to_say' || p === 'prefer_not_to_say') return false;
      if (s === 'apolitical' || p === 'apolitical') return false;
      return s !== p;
    }
    default:
      return false;
  }
}

// Dealbreaker check — returns { clean, triggered }. Single triggered dealbreaker
// on either side zeros the score — no compounding.
function dealbreakersCheck(a: any, b: any): { clean: number; triggered: string[] } {
  const aBreakers: string[] = Array.isArray(a?.dealbreakers) ? a.dealbreakers : [];
  const bBreakers: string[] = Array.isArray(b?.dealbreakers) ? b.dealbreakers : [];
  const triggered: string[] = [];
  for (const d of aBreakers) {
    if (isDealbreakerTriggered(d, b, a)) triggered.push(d);
  }
  for (const d of bBreakers) {
    if (isDealbreakerTriggered(d, a, b)) triggered.push(d);
  }
  return { clean: triggered.length === 0 ? 1 : 0, triggered };
}

// ─── Spark scoring ────────────────────────────────────────────────────────────

function sparkCoreFitScore(a: any, b: any): number {
  const scores = [
    exactMatch((a as any).intent, (b as any).intent),
    ageCompatibility(a, b),
    attractionCompatibility(a, b),
  ];
  return scores.reduce((x, y) => x + y, 0) / scores.length;
}

/**
 * PRE-TIER-1 SCORING — scheduled for replacement in Phase 6.
 *
 * This function uses the Tier 0 array-overlap algorithm against raw user
 * fields (relationshipValues, loveLangGive, etc.) and does NOT compute
 * facet vectors or emit archetype classification.
 *
 * The Tier 1 successor is src/services/scorePair.ts, which currently has
 * zero production consumers (archetype-ready infrastructure awaiting
 * cutover).
 *
 * Phase 6 tasks:
 *   - Replace this function's algorithm with Tier 1 facet scoring
 *   - Wire matchSparkArchetype + matchUnlikelyFit
 *   - Backfill archetype field on existing pair docs via migration
 *     Cloud Function (doc Section 11.2)
 *
 * See docs/phase6-checklist.md for full scope.
 */
export function calculateSparkScore(
  userA: UserDoc,
  userB: UserDoc
): {
  score: number;
  breakdown: SparkBreakdown;
  triggeredDealbreakers: string[];
  tier1: {
    archetype:      unknown;
    combinedScore:  number;
    asymmetryGap:   number;
    dataConfidence: number;
  } | null;
} {
  const a = userA as any;
  const b = userB as any;

  const dealbreakerResult = dealbreakersCheck(a, b);

  const breakdown: SparkBreakdown = {
    coreFit:      Math.round(sparkCoreFitScore(a, b) * 100),
    dealbreakers: dealbreakerResult.clean * 100,

    valuesIntentions: Math.round(arrayOverlap(
      [...(a.relationshipValues ?? []), a.intent ?? ''],
      [...(b.relationshipValues ?? []), b.intent ?? '']
    ) * 100),

    physicalPrefs: Math.round(
      ((physicalPrefScore(a, b) + physicalPrefScore(b, a)) / 2) * 100
    ),

    // Cross-match love languages: a gives what b receives and vice versa
    loveLanguages: Math.round(
      ((arrayOverlap(a.loveLangGive ?? [], b.loveLangReceive ?? []) +
        arrayOverlap(b.loveLangGive ?? [], a.loveLangReceive ?? [])) / 2) * 100
    ),

    lifestyle: Math.round(arrayOverlap(
      a.weekendVibes ?? [],
      b.weekendVibes ?? []
    ) * 100),

    personality: Math.round(arrayOverlap(
      a.personalityTraits ?? [],
      b.personalityTraits ?? []
    ) * 100),
  };

  const score = Math.round(
    breakdown.coreFit          * SPARK_WEIGHTS.coreFit +
    breakdown.valuesIntentions * SPARK_WEIGHTS.valuesIntentions +
    breakdown.physicalPrefs    * SPARK_WEIGHTS.physicalPrefs +
    breakdown.loveLanguages    * SPARK_WEIGHTS.loveLanguages +
    breakdown.lifestyle        * SPARK_WEIGHTS.lifestyle +
    breakdown.personality      * SPARK_WEIGHTS.personality
  );

  // ── Tier 1 metadata (additive, fail-open) ──────────────────────────────
  let tier1: {
    archetype:      unknown;
    combinedScore:  number;
    asymmetryGap:   number;
    dataConfidence: number;
  } | null = null;
  try {
    const aVec = computeFacetProfile(a as unknown as DatingProfile);
    const bVec = computeFacetProfile(b as unknown as DatingProfile);
    const pair = computePairScore(a as unknown as DatingProfile, b as unknown as DatingProfile, aVec, bVec);
    tier1 = {
      archetype:      pair.archetype,
      // Cap at 100 when a dealbreaker fired — Tier 1 facet scoring can
      // exceed 100 from bonus stacking, but a triggered dealbreaker should
      // never display as a >100% match. dealbreakerResult is in scope from
      // earlier in calculateSparkScore.
      combinedScore:  dealbreakerResult.triggered.length > 0
        ? Math.min(100, pair.combinedScore)
        : pair.combinedScore,
      asymmetryGap:   pair.asymmetryData.gap,
      dataConfidence: pair.dataConfidence,
    };
  } catch (err) {
    console.warn("[scoring] Tier 1 metadata computation failed", err);
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    breakdown,
    triggeredDealbreakers: dealbreakerResult.triggered,
    tier1,
  };
}

// ─── Play scoring ─────────────────────────────────────────────────────────────

const SPICE_ORDER = ['vanilla', 'spicy', 'blindfold', 'unleashed', 'no_limits'];

function spiceLevelCompatibility(a: string | null, b: string | null): number {
  if (!a || !b) return 0.5;
  if (a === b) return 1;
  const idxA = SPICE_ORDER.indexOf(a);
  const idxB = SPICE_ORDER.indexOf(b);
  if (idxA === -1 || idxB === -1) return 0.5;
  const diff = Math.abs(idxA - idxB);
  if (diff === 1) return 0.75;
  if (diff === 2) return 0.4;
  return 0.1;
}

function playNonNegotiableScore(a: any, b: any): number {
  const scores = [
    ageCompatibility(a, b),
    attractionCompatibility(a, b),
    spiceLevelCompatibility(a.spiceLevel ?? null, b.spiceLevel ?? null),
  ];
  return scores.reduce((x, y) => x + y, 0) / scores.length;
}

const VIBE_DYNAMIC_TAGS = new Set([
  'slow_and_sensual','passionate','spontaneous','adventurous','communicative',
  'body_positive','sober_play','chem_friendly','safe_only','high_chemistry_only',
  'emotionally_safe','dirty_talk','restraints','rough_play','gentle_lover',
  'intense','playful','teasing','eye_contact','vocal','quiet_intensity',
  'sensory_focused','connection_first','purely_physical','laugh_during',
  'takes_charge','follows_lead','both_directions','no_kissing',
  'dom','sub','switch_role','vanilla_only','light_bdsm','role_play',
  'exhibitionist','voyeur','group_open','hard_bdsm','bondage','impact_play',
  'praise_kink','degradation','daddy_dom','mommy_dom','pet_play',
  'orgasm_control','cuckolding','hotwife','threesome_mmf','threesome_ffm',
  'rough','gentle_dom',
]);

const ARRANGEMENT_ACTS_TAGS = new Set([
  'one_and_done','fwb','regular_thing','no_strings','situationship','open_to_more',
  'discreet','locals_only','travel_hookup','long_distance','online_only',
  'sugar_dynamic','poly_friendly','ethically_non_mono',
  'kissing','making_out','touching','oral_giving','oral_receiving','oral_both',
  'all_the_way','anal','mutual_pleasure','sexting','video_fun','toys',
  'massage','overnight','multiple_rounds','mutual_masturbation','edging',
  'tantric','sensory_play','body_worship','pegging','sixty_nine',
  'shower_fun','public_risk','outdoor',
]);

// Reuses SPICE_ORDER declared above for spiceLevelCompatibility.
function isSpiceAligned(a: string, b: string): boolean {
  const ai = SPICE_ORDER.indexOf(a);
  const bi = SPICE_ORDER.indexOf(b);
  if (ai === -1 || bi === -1) return false;
  return Math.abs(ai - bi) <= 1;
}

export function calculatePlayScore(
  userA: UserDoc,
  userB: UserDoc
): {
  score: number;
  breakdown: PlayBreakdown;
  tier1: {
    archetype:      NonNullable<ReturnType<typeof matchPlayArchetype>>;
    combinedScore:  number;
    asymmetryGap:   number;
    dataConfidence: number;
  } | null;
} {
  const a = userA as any;
  const b = userB as any;

  const breakdown: PlayBreakdown = {
    nonNegotiables: Math.round(playNonNegotiableScore(a, b) * 100),

    physicalCompatibility: Math.round(
      ((physicalPrefScore(a, b) + physicalPrefScore(b, a)) / 2) * 100
    ),

    energyVibe: Math.round(arrayOverlap(
      (a.playInterestTags ?? []).filter((t: string) => VIBE_DYNAMIC_TAGS.has(t)),
      (b.playInterestTags ?? []).filter((t: string) => VIBE_DYNAMIC_TAGS.has(t))
    ) * 100),

    intentionsLimits: Math.round(arrayOverlap(
      (a.playInterestTags ?? []).filter((t: string) => ARRANGEMENT_ACTS_TAGS.has(t)),
      (b.playInterestTags ?? []).filter((t: string) => ARRANGEMENT_ACTS_TAGS.has(t))
    ) * 100),
  };

  const score = Math.round(
    breakdown.nonNegotiables        * PLAY_WEIGHTS.nonNegotiables +
    breakdown.physicalCompatibility * PLAY_WEIGHTS.physicalCompatibility +
    breakdown.energyVibe            * PLAY_WEIGHTS.energyVibe +
    breakdown.intentionsLimits      * PLAY_WEIGHTS.intentionsLimits
  );

  // Compute Play archetype, wrapped to match Spark's tier1 shape so the UI
  // can read tier1.archetype.label uniformly across both modes.
  const facetA = computeFacetProfile(userA as any);
  const facetB = computeFacetProfile(userB as any);
  const spiceAligned = isSpiceAligned(a.spiceLevel ?? '', b.spiceLevel ?? '');
  const archetype = matchPlayArchetype(facetA, facetB, spiceAligned) ?? null;

  return {
    score: Math.min(100, Math.max(0, score)),
    breakdown,
    tier1: archetype ? {
      archetype,
      combinedScore: score,
      asymmetryGap:  0,
      dataConfidence: 1,
    } : null,
  };
}
