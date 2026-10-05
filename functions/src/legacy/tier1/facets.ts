// src/constants/facets.ts
//
// Zylove psychological facet vocabulary — single source of truth.
// Source: Tier 1 design doc v2, Section 2 (32 facets across 7 clusters).
//
// Downstream consumers:
//   - src/constants/traitToFacetMap.ts    — enum → facet weight mappings
//   - src/services/facetProfile.ts        — user-level facet vector computation
//   - src/services/archetypeMatcher.ts    — archetype classification
//   - compatibility scoring               — similarity vs complementarity per facet
//
// Each facet has a polarity hint that tells downstream scoring how to interpret
// the score. 'positive' facets are similarity-seeking where higher is healthier.
// 'neutral' facets are orientation-style where high and low are different, not
// better or worse (used for complementarity-allowed matching).

export type FacetCluster =
  | 'openness_novelty'       // Cluster A — relation to new experiences and ideas
  | 'energy_social'          // Cluster B — social energy and stimulation preferences
  | 'emotional_regulation'   // Cluster C — emotional processing and awareness
  | 'structure_discipline'   // Cluster D — organization, drive, and routine
  | 'relational_orientation' // Cluster E — how someone shows up in partnership
  | 'values_meaning'         // Cluster F — underlying ethical and meaning frameworks
  | 'expression_play'        // Cluster G — creative and embodied self-expression

export type FacetPolarity = 'positive' | 'negative' | 'neutral'

export interface Facet {
  id:          string
  name:        string
  description: string
  category:    FacetCluster
  polarity:    FacetPolarity
}

export const FACETS = {
  // ─── Cluster A — Openness & Novelty (5) ────────────────────────────────
  OPENNESS_TO_NOVELTY: {
    id:          'openness_to_novelty',
    name:        'Openness to Novelty',
    description: 'Comfort with new experiences, change, and unfamiliar situations. High scorers seek variety; low scorers prefer the known.',
    category:    'openness_novelty',
    polarity:    'neutral',
  },
  INTELLECTUAL_CURIOSITY: {
    id:          'intellectual_curiosity',
    name:        'Intellectual Curiosity',
    description: 'Drive to explore ideas, ask questions, and learn for its own sake. About inquiry breadth, distinct from analytical depth.',
    category:    'openness_novelty',
    polarity:    'positive',
  },
  AESTHETIC_SENSITIVITY: {
    id:          'aesthetic_sensitivity',
    name:        'Aesthetic Sensitivity',
    description: 'Awareness of and responsiveness to beauty, design, art, and sensory experience.',
    category:    'openness_novelty',
    polarity:    'neutral',
  },
  RISK_TOLERANCE: {
    id:          'risk_tolerance',
    name:        'Risk Tolerance',
    description: 'Willingness to accept uncertainty and potential loss for possible gain. High scorers embrace the unfamiliar; low scorers prefer predictable outcomes.',
    category:    'openness_novelty',
    polarity:    'neutral',
  },
  SPONTANEITY: {
    id:          'spontaneity',
    name:        'Spontaneity',
    description: 'Preference for unplanned action and in-the-moment decision-making over structured planning.',
    category:    'openness_novelty',
    polarity:    'neutral',
  },

  // ─── Cluster B — Energy & Social (4) ───────────────────────────────────
  EXTRAVERSION_SOCIAL: {
    id:          'extraversion_social',
    name:        'Social Extraversion',
    description: 'Energy gained from social interaction vs. solitude. High scorers are energized by people; low scorers recharge alone.',
    category:    'energy_social',
    polarity:    'neutral',
  },
  SOCIAL_BREADTH: {
    id:          'social_breadth',
    name:        'Social Breadth',
    description: 'Preference for many relationships vs. fewer deep ones. Orthogonal to introversion — one can be deeply extraverted with only a few close friends.',
    category:    'energy_social',
    polarity:    'neutral',
  },
  HIGH_AROUSAL_PREFERENCE: {
    id:          'high_arousal_preference',
    name:        'High-Arousal Preference',
    description: 'Taste for high-energy, stimulating environments (loud music, crowds, fast pace) vs. calm, low-stimulation settings.',
    category:    'energy_social',
    polarity:    'neutral',
  },
  PUBLIC_PRESENTATION: {
    id:          'public_presentation',
    name:        'Public Presentation',
    description: 'Comfort being visible, observed, or performing in front of others. High scorers enjoy attention; low scorers prefer to stay unobserved.',
    category:    'energy_social',
    polarity:    'neutral',
  },

  // ─── Cluster C — Emotional Regulation (4) ──────────────────────────────
  EMOTIONAL_STABILITY: {
    id:          'emotional_stability',
    name:        'Emotional Stability',
    description: 'Capacity to regulate emotions under stress. Low scorers experience bigger swings and more reactivity to everyday events.',
    category:    'emotional_regulation',
    polarity:    'positive',
  },
  EMOTIONAL_DEPTH: {
    id:          'emotional_depth',
    name:        'Emotional Depth',
    description: 'Intensity and richness of emotional experience. High scorers feel deeply and care intensely; low scorers stay emotionally level.',
    category:    'emotional_regulation',
    polarity:    'neutral',
  },
  CONFLICT_DIRECTNESS: {
    id:          'conflict_directness',
    name:        'Conflict Directness',
    description: 'Willingness to address disagreement openly. High scorers engage conflict head-on; low scorers prefer to avoid, defer, or process privately first.',
    category:    'emotional_regulation',
    polarity:    'neutral',
  },
  SELF_AWARENESS: {
    id:          'self_awareness',
    name:        'Self-Awareness',
    description: "Capacity to observe one's own thoughts, emotions, and behavioral patterns accurately.",
    category:    'emotional_regulation',
    polarity:    'positive',
  },

  // ─── Cluster D — Structure & Discipline (4) ────────────────────────────
  CONSCIENTIOUSNESS: {
    id:          'conscientiousness',
    name:        'Conscientiousness',
    description: 'Reliability, organization, and follow-through on commitments. High scorers plan and execute; low scorers are more improvisational.',
    category:    'structure_discipline',
    polarity:    'positive',
  },
  LIFESTYLE_DISCIPLINE: {
    id:          'lifestyle_discipline',
    name:        'Lifestyle Discipline',
    description: 'Consistency in behaviors supporting long-term health and goals — sleep, exercise, substance use, daily routines.',
    category:    'structure_discipline',
    polarity:    'neutral',
  },
  AMBITION_DRIVE: {
    id:          'ambition_drive',
    name:        'Ambition & Drive',
    description: 'Motivation to achieve external goals — career, status, accomplishment. High scorers orient life around striving.',
    category:    'structure_discipline',
    polarity:    'neutral',
  },
  ROUTINE_PREFERENCE: {
    id:          'routine_preference',
    name:        'Routine Preference',
    description: 'Preference for stable daily patterns vs. variety. High scorers thrive on structure; low scorers need novelty to feel alive.',
    category:    'structure_discipline',
    polarity:    'neutral',
  },

  // ─── Cluster E — Relational Orientation (6) ────────────────────────────
  EMOTIONAL_AVAILABILITY: {
    id:          'emotional_availability',
    name:        'Emotional Availability',
    description: 'Willingness and capacity to be emotionally present and open in close relationships.',
    category:    'relational_orientation',
    polarity:    'positive',
  },
  AUTONOMY_VALUED: {
    id:          'autonomy_valued',
    name:        'Autonomy Valued',
    description: 'Priority placed on personal independence within a partnership. High scorers need space and separate interests; low scorers prefer entwined lives.',
    category:    'relational_orientation',
    polarity:    'neutral',
  },
  COMMITMENT_ORIENTATION: {
    id:          'commitment_orientation',
    name:        'Commitment Orientation',
    description: 'Readiness for long-term partnership and fidelity. High scorers seek lasting commitment; low scorers keep options open.',
    category:    'relational_orientation',
    polarity:    'neutral',
  },
  NURTURING_IMPULSE: {
    id:          'nurturing_impulse',
    name:        'Nurturing Impulse',
    description: 'Tendency to care for, support, and provide for partners and loved ones through action.',
    category:    'relational_orientation',
    polarity:    'neutral',
  },
  PARTNERSHIP_EGALITARIANISM: {
    id:          'partnership_egalitarianism',
    name:        'Partnership Egalitarianism',
    description: 'Belief in equal status and shared responsibility within a partnership.',
    category:    'relational_orientation',
    polarity:    'positive',
  },
  FAMILY_ORIENTATION: {
    id:          'family_orientation',
    name:        'Family Orientation',
    description: 'Importance of family as a central life priority — including extended family, shared traditions, and future-family aspirations.',
    category:    'relational_orientation',
    polarity:    'neutral',
  },

  // ─── Cluster F — Values & Meaning (5) ──────────────────────────────────
  INTEGRITY_VALUED: {
    id:          'integrity_valued',
    name:        'Integrity Valued',
    description: 'Importance placed on honesty, consistency between stated values and action, and principled behavior.',
    category:    'values_meaning',
    polarity:    'positive',
  },
  SPIRITUAL_OPENNESS: {
    id:          'spiritual_openness',
    name:        'Spiritual Openness',
    description: 'Engagement with spirituality, faith, meaning-making, or transcendent experience — regardless of specific tradition.',
    category:    'values_meaning',
    polarity:    'neutral',
  },
  SOCIAL_CONSCIOUSNESS: {
    id:          'social_consciousness',
    name:        'Social Consciousness',
    description: 'Attention to broader social, ethical, and political issues beyond personal life.',
    category:    'values_meaning',
    polarity:    'neutral',
  },
  TRADITION_VALUED: {
    id:          'tradition_valued',
    name:        'Tradition Valued',
    description: 'Respect for established customs, cultural practices, and continuity with the past.',
    category:    'values_meaning',
    polarity:    'neutral',
  },
  PERSONAL_GROWTH_FOCUS: {
    id:          'personal_growth_focus',
    name:        'Personal Growth Focus',
    description: 'Commitment to ongoing self-development, therapy, reflection, and becoming a better version of oneself.',
    category:    'values_meaning',
    polarity:    'positive',
  },

  // ─── Cluster G — Expression & Play (4) ─────────────────────────────────
  PLAYFULNESS: {
    id:          'playfulness',
    name:        'Playfulness',
    description: 'Capacity for lightness, humor, and play in daily life and relationships.',
    category:    'expression_play',
    polarity:    'neutral',
  },
  SENSUALITY: {
    id:          'sensuality',
    name:        'Sensuality',
    description: 'Attunement to physical and sensory pleasure — food, touch, texture, embodied experience.',
    category:    'expression_play',
    polarity:    'neutral',
  },
  VERBAL_EXPRESSIVENESS: {
    id:          'verbal_expressiveness',
    name:        'Verbal Expressiveness',
    description: 'Tendency to communicate thoughts and feelings through words. High scorers process aloud; low scorers hold thoughts internally.',
    category:    'expression_play',
    polarity:    'neutral',
  },
  PHYSICAL_EXPRESSIVENESS: {
    id:          'physical_expressiveness',
    name:        'Physical Expressiveness',
    description: 'Tendency to communicate through physical touch, proximity, and body language.',
    category:    'expression_play',
    polarity:    'neutral',
  },
} as const satisfies Record<string, Facet>

// ─── Derived types ────────────────────────────────────────────────────────

export type FacetKey = keyof typeof FACETS
export type FacetId  = (typeof FACETS)[FacetKey]['id']

// ─── Cluster metadata (for UI display + grouping) ─────────────────────────

export const FACET_CLUSTERS: Record<FacetCluster, { label: string; description: string }> = {
  openness_novelty:       { label: 'Openness & Novelty',      description: 'How someone relates to new experiences and ideas' },
  energy_social:          { label: 'Energy & Social',         description: 'Social energy and stimulation preferences' },
  emotional_regulation:   { label: 'Emotional Regulation',    description: 'Emotional processing and self-awareness' },
  structure_discipline:   { label: 'Structure & Discipline',  description: 'Organization, drive, and routine preference' },
  relational_orientation: { label: 'Relational Orientation',  description: 'How someone shows up in partnership' },
  values_meaning:         { label: 'Values & Meaning',        description: 'Underlying ethical and meaning frameworks' },
  expression_play:        { label: 'Expression & Play',       description: 'Creative and embodied self-expression' },
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function getFacetById(id: string): Facet | undefined {
  return Object.values(FACETS).find(f => f.id === id)
}

export function getFacetsInCluster(cluster: FacetCluster): Facet[] {
  return Object.values(FACETS).filter(f => f.category === cluster)
}

export const ALL_FACET_IDS: readonly FacetId[] =
  Object.values(FACETS).map(f => f.id) as readonly FacetId[]
