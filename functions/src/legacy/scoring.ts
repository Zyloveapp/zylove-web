// functions/src/scoring.ts
//
// Server-side compatibility scoring.
// Field names corrected to match actual Firestore data from onboarding.

import { UserDoc, SparkBreakdown, PlayBreakdown } from "./types";
import { analyzeFacets } from "./tier1/facetProfile";
import { computePairScore, DEALBREAKER_CAP, hasEnoughInfo, shrinkToPrior } from "./tier1/scorePair";
import { calibrateTier0 } from "./tier1/calibration";
import { matchPlayArchetype } from "./tier1/archetypeMatcher";
import type { DatingProfile } from "./types";

// The scoring engine's version, stored on every pair score (engineVersion).
// Bump it with any change to the Spark math, mappings or calibration: onTap
// re-scores pairs from older versions, and scripts/rescore-pairs.mjs
// backfills them.
//   1 — original Tier 0 / Tier 1 (missing data = neutral match, 3× physical)
//   2 — 2026-10 overhaul: missing data excluded, caps, dealbreakers lower
//       the score, 27 web answers mapped, calibrated, "Not enough info"
//   3 — F-100 / F-098 (2026-10-09): intent no longer scored; Deep Fit
//       records trimmed (no raw floats), labels without dealbreaker shadow
//       facets, the physical bar per viewer
export const SCORE_ENGINE_VERSION = 3;

// Tier 0 category weights. Categories with no data on one side are left out
// and the rest renormalized. A triggered dealbreaker halves the score per
// trigger and caps it (DEALBREAKER_CAP).
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
  everyone:        ['*'],
};

// §4.A2 / F-098: "Trans men" / "Trans women" attraction counts as men /
// women, as Explore matches (explore.ts) — kept apart, a cis person's score
// went to 0 for someone attracted only to trans women while a trans
// person's didn't, telling the hidden gender apart. No trans filter anywhere.
const ATTRACTION_FOLD: Record<string, string> = { transmen: 'men', transwomen: 'women' };
const attractionKey = (v: unknown): string => {
  const k = canonical(v);
  return ATTRACTION_FOLD[k] ?? k;
};

const OFF_MAP_IDENTITIES = new Set(['genderfluid', 'agender', 'selfdescribe']);

// Defensive against: undefined/null inputs, array-typed gender (Play mode),
// non-string values, and underscore/hyphen/space variations.
function prefMatchesGender(pref: unknown, gender: unknown, matchableAs?: unknown): boolean {
  const prefKey = attractionKey(pref);
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
      const mKey = attractionKey(m);
      if (mKey === prefKey || mKey === 'everyone') return true;
    }
  }
  return false;
}

// Hard-zero on any one-way orientation rejection. Only mutual yes returns 1.
export function attractionCompatibility(a: any, b: any): number {
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
  // Both people can rule out the same thing (e.g. different_politics): list it once.
  const unique = [...new Set(triggered)];
  return { clean: unique.length === 0 ? 1 : 0, triggered: unique };
}

// ─── Spark scoring ────────────────────────────────────────────────────────────

// Engine v2 helpers: null = no data on one side (excluded, never a match).
function overlapOrNull(a: unknown, b: unknown): number | null {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return null;
  return arrayOverlap(a, b);
}

function mean(xs: (number | null)[]): number | null {
  const known = xs.filter((x): x is number => x !== null);
  return known.length ? known.reduce((x, y) => x + y, 0) / known.length : null;
}

// Viewer's physical criteria vs the target, 0–1; null when none stated.
function physicalOrNull(viewer: any, target: any): number | null {
  const scores: number[] = [];
  if (viewer?.seekingHeightMinCm && viewer?.seekingHeightMaxCm && target?.heightCm) {
    scores.push(target.heightCm >= viewer.seekingHeightMinCm && target.heightCm <= viewer.seekingHeightMaxCm ? 1 : 0.2);
  }
  if (Array.isArray(viewer?.seekingBodyTypes) && viewer.seekingBodyTypes.length && target?.bodyType) {
    scores.push(viewer.seekingBodyTypes.includes(target.bodyType) ? 1 : 0.3);
  }
  return scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null;
}

const pct = (v: number | null): number | null => (v === null ? null : Math.round(v * 100));

const NON_CORE: (keyof typeof SPARK_WEIGHTS)[] = ["valuesIntentions", "physicalPrefs", "loveLanguages", "lifestyle", "personality"];

/**
 * Spark compatibility for a pair. `score` is the one headline everyone sees:
 * the Deep Fit (Tier 1, facet-based) score, or Tier 0 if Tier 1 fails.
 * Tier 0 survives as the category breakdown (Spark+ bars). `tier1` carries
 * Deep Fit's detail — both directions and the reasons (Elite).
 *
 * Both engines: missing data is excluded, not a match; thin evidence pulls
 * toward EVIDENCE_PRIOR; a dealbreaker caps the score at DEALBREAKER_CAP;
 * calibration.ts maps the result onto the display scale. `enoughInfo`
 * (shared by both) says whether the number means anything.
 */
export function calculateSparkScore(
  userA: UserDoc,
  userB: UserDoc
): {
  score: number;
  enoughInfo: boolean;
  // Engine output before calibration, shrinkage and caps (for calibration
  // and audits; never stored or shown).
  raw: { tier0: number; tier1: number | null };
  // The Tier 0 score on the display scale (the headline's fallback).
  tier0Score: number;
  // The Tier 0 categories. physicalPrefs here is the mean of both
  // directions (it feeds tier0Score); never stored or shown as is — F-098:
  // see sparkBreakdownRecord.
  breakdown: SparkBreakdown;
  // Each direction's physical fit, 0–100 (null: no criteria stated):
  // ab = how well B fits A's physical preferences, ba = A fits B's.
  physicalDirections: { ab: number | null; ba: number | null };
  triggeredDealbreakers: string[];
  tier1: Tier1Spark | null;
} {
  const a = userA as any;
  const b = userB as any;

  const dealbreakerResult = dealbreakersCheck(a, b);
  const attraction = attractionCompatibility(a, b);

  const breakdown: SparkBreakdown = {
    // F-100: intent left out (as Deep Fit's intentScore) — the bar moved
    // 100/83 vs 67/50 when you switched your own, showing theirs.
    coreFit: Math.round(((ageCompatibility(a, b) + attraction) / 2) * 100),
    dealbreakers: dealbreakerResult.clean * 100,
    valuesIntentions: pct(overlapOrNull(a.relationshipValues, b.relationshipValues)),
    physicalPrefs: pct(mean([physicalOrNull(a, b), physicalOrNull(b, a)])),
    // Cross-match love languages: a gives what b receives and vice versa
    loveLanguages: pct(mean([overlapOrNull(a.loveLangGive, b.loveLangReceive), overlapOrNull(b.loveLangGive, a.loveLangReceive)])),
    lifestyle: pct(overlapOrNull(a.weekendVibes, b.weekendVibes)),
    personality: pct(overlapOrNull(a.personalityTraits, b.personalityTraits)),
  };

  // Shared facet evidence decides "Not enough info" for both engines.
  const facetsA = analyzeFacets(a as unknown as DatingProfile);
  const facetsB = analyzeFacets(b as unknown as DatingProfile);

  // Tier 0 raw: weighted average of the categories with data on both sides.
  const parts: [number, number][] = [[SPARK_WEIGHTS.coreFit, breakdown.coreFit]];
  for (const k of NON_CORE) {
    const v = breakdown[k];
    if (v !== null) parts.push([SPARK_WEIGHTS[k], v]);
  }
  const raw0 = attraction === 0 ? 0 : parts.reduce((n, [w, v]) => n + w * v, 0) / parts.reduce((n, [w]) => n + w, 0);

  // ── Tier 1 (fail-open) ──────────────────────────────────────────────────
  let tier1: Tier1Spark | null = null;
  // Shared facet evidence (0–1) — the one measure of how much we know, for
  // both engines. 0 if Tier 1 fails, so Tier 0 falls to the prior.
  let coverage = 0;
  let raw1: number | null = null;
  try {
    const pair = computePairScore(a as unknown as DatingProfile, b as unknown as DatingProfile, facetsA, facetsB);
    coverage = pair.coverage;
    raw1 = pair.combinedRaw;
    // Tier 0's dealbreakers (habits, drinking, kids…) cap Deep Fit too; Tier 1
    // only sees the facet-shaped ones.
    const cap = (v: number) => (dealbreakerResult.triggered.length > 0 ? Math.min(DEALBREAKER_CAP, v) : v);
    tier1 = {
      // A dealbreaker pair gets no archetype: its copy would read as a
      // romance the score (≤ 35) contradicts.
      archetype:      dealbreakerResult.triggered.length > 0 ? null : pair.archetype,
      combinedScore:  cap(pair.combinedScore),
      directions:     { ab: cap(pair.displayAB), ba: cap(pair.displayBA) },
      strengths:      pair.strengths,
      differences:    pair.differences,
      asymmetryGap:   pair.asymmetryData.gap,
      dataConfidence: pair.dataConfidence,
      coverage:       pair.coverage,
      enoughInfo:     pair.enoughInfo,
    };
  } catch (err) {
    console.warn("[scoring] Tier 1 computation failed", err);
  }

  let tier0Score = attraction === 0 ? 0 : shrinkToPrior(calibrateTier0(raw0), coverage);
  const n = dealbreakerResult.triggered.length;
  if (n > 0) tier0Score = Math.min(DEALBREAKER_CAP, tier0Score * Math.pow(0.5, n));
  const headline = attraction === 0 ? 0 : tier1 ? tier1.combinedScore : tier0Score;

  return {
    score: Math.round(Math.min(100, Math.max(0, headline))),
    tier0Score: Math.round(Math.min(100, Math.max(0, tier0Score))),
    enoughInfo: attraction !== 0 && hasEnoughInfo(coverage, facetsA.recognized, facetsB.recognized),
    raw: { tier0: raw0, tier1: raw1 },
    breakdown,
    physicalDirections: { ab: pct(physicalOrNull(a, b)), ba: pct(physicalOrNull(b, a)) },
    triggeredDealbreakers: dealbreakerResult.triggered,
    tier1,
  };
}

// Deep Fit detail as calculateSparkScore returns it, A/B = its arguments.
export interface Tier1Spark {
  archetype:      unknown;
  combinedScore:  number;
  // Display scale: ab = how well B fits A, ba = how well A fits B.
  directions:     { ab: number; ba: number };
  strengths:      string[];
  differences:    string[];
  asymmetryGap:   number;
  dataConfidence: number;
  coverage:       number;
  enoughInfo:     boolean;
}

// What pairs/{id}/modes/deep stores (Elite): Deep Fit with the directions
// keyed by uid — fitFor[uid] = how well the other person fits that uid —
// so either person's view reads the same doc. F-098: only the public shape
// (publicDeepFit) is stored.
export function deepFitRecord(tier1: Tier1Spark | null, uidA: string, uidB: string): DeepFitRecord | null {
  if (!tier1) return null;
  const { directions, ...rest } = tier1;
  return publicDeepFit({ ...rest, fitFor: { [uidA]: directions.ab, [uidB]: directions.ba } });
}

// ─── F-098: Deep Fit as stored and shown ─────────────────────────────────────
// Unrounded floats (combinedScore, the directions, asymmetryGap, the
// archetype's confidence, coverage) could be inverted, with edits to your own
// profile, into the other person's private preferences and dealbreakers. So
// Deep Fit is stored and returned only as: the archetype's id/label/copy, a
// rounded combined score, each direction in bands of FIT_BAND, the asymmetry
// as a band (asymmetryBand), the reasons and enoughInfo. Every path that
// returns a stored record to a client runs it through publicDeepFit /
// publicPlayTier1 too: older docs keep the raw fields until re-scored.

export const FIT_BAND = 5;
const toBand = (v: number): number => Math.round(v / FIT_BAND) * FIT_BAND;

export interface PublicArchetype { id: string; label: string; copy: string }

export interface DeepFitRecord {
  archetype:     PublicArchetype | null;
  combinedScore: number | null;
  fitFor:        Record<string, number>;
  asymmetryBand: AsymmetryBand | null;
  strengths:     string[];
  differences:   string[];
  enoughInfo:    boolean | null;
}

// |A→B − B→A| (score points) in the bands the app words it by (compare.ts
// whyThisWorks): 0 under 5, 1 up to 10, 2 up to 20, 3 above.
export type AsymmetryBand = 0 | 1 | 2 | 3;
export function asymmetryBand(gap: number): AsymmetryBand {
  return gap < 5 ? 0 : gap <= 10 ? 1 : gap <= 20 ? 2 : 3;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function publicArchetype(v: unknown): PublicArchetype | null {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== "string" || typeof a.label !== "string") return null;
  return { id: a.id, label: a.label, copy: typeof a.copy === "string" ? a.copy : "" };
}

// A stored Deep Fit record (any engine's shape) as it may be shown.
export function publicDeepFit(v: unknown): DeepFitRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  const fitFor = typeof t.fitFor === "object" && t.fitFor !== null
    ? Object.fromEntries(Object.entries(t.fitFor).filter((e): e is [string, number] => finite(e[1])).map(([k, n]) => [k, toBand(n)]))
    : {};
  const band = finite(t.asymmetryBand) && [0, 1, 2, 3].includes(t.asymmetryBand)
    ? (t.asymmetryBand as AsymmetryBand)
    : finite(t.asymmetryGap) ? asymmetryBand(t.asymmetryGap) : null;
  return {
    archetype:     publicArchetype(t.archetype),
    combinedScore: finite(t.combinedScore) ? Math.round(t.combinedScore) : null,
    fitFor,
    asymmetryBand: band,
    strengths:     stringList(t.strengths),
    differences:   stringList(t.differences),
    enoughInfo:    typeof t.enoughInfo === "boolean" ? t.enoughInfo : null,
  };
}

// Play's tier1 as stored and shown: the archetype (no confidence) and the
// Play score; null without an archetype.
export function publicPlayTier1(v: unknown): { archetype: PublicArchetype; combinedScore: number | null } | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  const archetype = publicArchetype(t.archetype);
  return archetype ? { archetype, combinedScore: finite(t.combinedScore) ? Math.round(t.combinedScore) : null } : null;
}

// Whether a stored record still carries fields publicDeepFit drops or
// changes (for scripts/rescore-pairs.mjs's count).
export function hasRawDeepFit(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  return JSON.stringify(v) !== JSON.stringify(publicDeepFit(v));
}
export function hasRawPlayTier1(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  return JSON.stringify(v) !== JSON.stringify(publicPlayTier1(v));
}

// ─── F-098: the Spark+ physical bar, per viewer ──────────────────────────────
// The breakdown's physicalPrefs was the mean of both directions, so with
// your own preferences known (or cleared) it gave away the other person's
// private seeking body type / height. Each person sees only their own
// direction — how well the other person fits what THEY want, from their own
// preferences and the other's public height and body type. Stored keyed by
// uid like Deep Fit's fitFor (pairs/{id}/modes/spark is server-only) and
// picked per viewer on every read (sparkBreakdownFor).

export type StoredSparkBreakdown = Omit<SparkBreakdown, "physicalPrefs"> & { physicalPrefsFor: Record<string, number | null> };

// What pairs/{id}/modes/spark stores; A/B = calculateSparkScore's arguments.
export function sparkBreakdownRecord(result: Pick<ReturnType<typeof calculateSparkScore>, "breakdown" | "physicalDirections">, uidA: string, uidB: string): StoredSparkBreakdown {
  const { physicalPrefs: _mean, ...rest } = result.breakdown;
  return { ...rest, physicalPrefsFor: { [uidA]: result.physicalDirections.ab, [uidB]: result.physicalDirections.ba } };
}

// A stored breakdown (any shape) as `viewerUid` may see it: physicalPrefs
// is their own direction. An older doc (only the two-way mean) shows none
// until re-scored.
export function sparkBreakdownFor(stored: unknown, viewerUid: string): Record<string, unknown> {
  if (typeof stored !== "object" || stored === null) return {};
  const { physicalPrefs: _mean, physicalPrefsFor, ...rest } = stored as Record<string, unknown>;
  const own = typeof physicalPrefsFor === "object" && physicalPrefsFor !== null ? (physicalPrefsFor as Record<string, unknown>)[viewerUid] : null;
  return { ...rest, physicalPrefs: finite(own) ? own : null };
}

// The pair-doc fields for a Spark result (the headline everyone sees).
export function sparkPairFields(result: ReturnType<typeof calculateSparkScore>): {
  sparkScore: number;
  sparkEnoughInfo: boolean;
  engineVersion: number;
} {
  return { sparkScore: result.score, sparkEnoughInfo: result.enoughInfo, engineVersion: SCORE_ENGINE_VERSION };
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
  // F-098: the public shape only (publicPlayTier1).
  tier1: { archetype: PublicArchetype; combinedScore: number | null } | null;
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
  // F-098: the label is displayed, so it's from the facets without
  // dealbreaker shadows (they'd show the private dealbreakers).
  const facetA = analyzeFacets(userA as any, { shadows: false }).vector;
  const facetB = analyzeFacets(userB as any, { shadows: false }).vector;
  const spiceAligned = isSpiceAligned(a.spiceLevel ?? '', b.spiceLevel ?? '');
  const archetype = matchPlayArchetype(facetA, facetB, spiceAligned) ?? null;

  return {
    score: Math.min(100, Math.max(0, score)),
    breakdown,
    tier1: publicPlayTier1(archetype ? { archetype, combinedScore: score } : null),
  };
}
