// Mirrors src/types/zyloveScore.ts in the web app (itself a copy of mobile's) — keep in sync.

// src/types/zyloveScore.ts
//
// Zylove Score — private behavioral reputation system.
//
// Score is ONLY visible to the profile owner.
// Others see only the outcome (Trusted badge, priority placement, etc.)
// Score is a weighted rolling average of post-interaction reviews.
// Each review = one completed conversation (min 5 messages exchanged).
//
// Design principles:
//   - Positive reviews carry more weight than negative (encourages good faith)
//   - Single bad review can't tank a score (minimum 3 reviews before penalties apply)
//   - Repeated serious flags (boundary pushing) trigger moderation regardless of score
//   - Score decays slowly if inactive (encourages continued engagement)

// ─── Review Categories ────────────────────────────────────────────────────────

export type ReviewCategory =
  // Positive signals
  | 'respectful'          // Treated me with respect throughout
  | 'great_conversationalist' // Engaging, interesting to talk to
  | 'made_me_feel_safe'   // 🌟 Gold signal — rare, high weight
  | 'genuine_authentic'   // Felt real, no games
  | 'kind'                // Warm and considerate
  | 'funny'               // Made me laugh
  | 'chemistry'           // Real spark between us
  | 'would_meet_irl'      // 🌟 Strongest signal — intent to meet
  | 'good_listener'       // Attentive, remembered details
  | 'responsive'          // Timely, consistent communicator

  // Negative signals
  | 'unresponsive'        // Took days to reply or went silent
  | 'unengaging'          // One-word answers, no effort
  | 'rude'                // Disrespectful tone or language
  | 'ghosted_me'          // Stopped responding mid-conversation
  | 'felt_fake'           // Profile didn't match conversation
  | 'too_pushy'           // Pressured or rushed things
  | 'inappropriate'       // ⚠ Flag — crossed a line
  | 'pushed_boundaries'   // 🚨 Serious flag — triggers review queue
  | 'misrepresented'      // Photos/bio didn't match reality

export type ReviewSentiment = 'positive' | 'neutral' | 'negative' | 'flag'

export interface ReviewCategoryMeta {
  id: ReviewCategory
  label: string
  emoji: string
  sentiment: ReviewSentiment
  weight: number          // contribution to score delta
  triggersModerationAt: number // how many times before auto-flag (0 = never)
  description: string
}

export const REVIEW_CATEGORIES: ReviewCategoryMeta[] = [
  // ── Positive ──────────────────────────────────────────────────────────────
  { id: 'would_meet_irl',       label: 'I\'d meet them IRL',        emoji: '✨', sentiment: 'positive', weight: 1.0,  triggersModerationAt: 0, description: 'I\'d genuinely want to meet this person in real life' },
  { id: 'made_me_feel_safe',    label: 'Made me feel safe',         emoji: '🛡',  sentiment: 'positive', weight: 0.95, triggersModerationAt: 0, description: 'I felt completely comfortable and respected' },
  { id: 'chemistry',            label: 'Real chemistry',            emoji: '⚡', sentiment: 'positive', weight: 0.85, triggersModerationAt: 0, description: 'There was a genuine spark between us' },
  { id: 'great_conversationalist',label:'Great conversationalist',  emoji: '💬', sentiment: 'positive', weight: 0.80, triggersModerationAt: 0, description: 'Engaging, thoughtful, interesting to talk to' },
  { id: 'genuine_authentic',    label: 'Genuine & authentic',       emoji: '💎', sentiment: 'positive', weight: 0.75, triggersModerationAt: 0, description: 'Felt real — no games, no performance' },
  { id: 'kind',                 label: 'Kind',                      emoji: '🤝', sentiment: 'positive', weight: 0.70, triggersModerationAt: 0, description: 'Warm, considerate, thoughtful' },
  { id: 'respectful',          label: 'Respectful',                emoji: '🌿', sentiment: 'positive', weight: 0.70, triggersModerationAt: 0, description: 'Treated me with respect the whole time' },
  { id: 'good_listener',       label: 'Great listener',            emoji: '👂', sentiment: 'positive', weight: 0.65, triggersModerationAt: 0, description: 'Remembered things, asked follow-up questions' },
  { id: 'funny',               label: 'Actually funny',            emoji: '😂', sentiment: 'positive', weight: 0.60, triggersModerationAt: 0, description: 'Made me laugh — genuinely' },
  { id: 'responsive',          label: 'Responsive',                emoji: '⚡', sentiment: 'positive', weight: 0.50, triggersModerationAt: 0, description: 'Timely replies, kept the energy going' },

  // ── Negative ──────────────────────────────────────────────────────────────
  { id: 'unengaging',          label: 'Low effort',                emoji: '😐', sentiment: 'negative', weight: -0.40, triggersModerationAt: 0, description: 'One-word answers, didn\'t try' },
  { id: 'unresponsive',        label: 'Slow to respond',           emoji: '🐢', sentiment: 'negative', weight: -0.40, triggersModerationAt: 0, description: 'Took a long time to reply or barely showed up' },
  { id: 'ghosted_me',          label: 'Ghosted',                   emoji: '👻', sentiment: 'negative', weight: -0.60, triggersModerationAt: 5, description: 'Stopped responding mid-conversation' },
  { id: 'felt_fake',           label: 'Felt fake',                 emoji: '🎭', sentiment: 'negative', weight: -0.65, triggersModerationAt: 4, description: 'Didn\'t seem genuine or authentic' },
  { id: 'too_pushy',           label: 'Too pushy',                 emoji: '⚠',  sentiment: 'negative', weight: -0.75, triggersModerationAt: 3, description: 'Pressured or rushed me' },
  { id: 'rude',                label: 'Rude',                      emoji: '🚫', sentiment: 'negative', weight: -0.80, triggersModerationAt: 3, description: 'Disrespectful tone or language' },
  { id: 'misrepresented',      label: 'Misrepresented themselves', emoji: '📸', sentiment: 'negative', weight: -0.70, triggersModerationAt: 4, description: 'Photos or bio didn\'t match reality' },

  // ── Serious flags ──────────────────────────────────────────────────────────
  { id: 'inappropriate',       label: 'Inappropriate',             emoji: '🚨', sentiment: 'flag',     weight: -1.0,  triggersModerationAt: 2, description: 'Said or sent something that crossed a line' },
  { id: 'pushed_boundaries',   label: 'Pushed my boundaries',      emoji: '🆘', sentiment: 'flag',     weight: -1.0,  triggersModerationAt: 2, description: 'Didn\'t respect boundaries I set' },
]

export const POSITIVE_CATEGORIES = REVIEW_CATEGORIES.filter(c => c.sentiment === 'positive')
export const NEGATIVE_CATEGORIES = REVIEW_CATEGORIES.filter(c => c.sentiment === 'negative')
export const FLAG_CATEGORIES = REVIEW_CATEGORIES.filter(c => c.sentiment === 'flag')

// ─── Review Document ──────────────────────────────────────────────────────────

export interface InteractionReview {
  id: string
  reviewerId: string        // who wrote this review
  revieweeUid: string       // who is being reviewed
  matchId: string           // the conversation this is based on
  categories: ReviewCategory[]
  // Optional freetext — max 200 chars, never shown to reviewee
  privateNote?: string
  createdAt: number
  // Dispute
  isDisputed: boolean
  disputeReason?: string
  disputedAt?: number
  disputeStatus?: 'pending' | 'upheld' | 'dismissed'
  // Moderation
  flaggedForReview: boolean
  reviewedByModerator: boolean
}

// ─── Zylove Score ──────────────────────────────────────────────────────────────

export type ZyloveScoreTier =
  | 'new'           // < 5 reviews — not enough data
  | 'building'      // 40–59
  | 'good'          // 60–74
  | 'great'         // 75–84
  | 'trusted'       // 85–94
  | 'elite'         // 95–100

export interface ZyloveScore {
  uid: string
  score: number               // 0–100, rolling weighted average
  tier: ZyloveScoreTier
  reviewCount: number
  positiveCount: number
  negativeCount: number
  flagCount: number
  topPositiveCategories: ReviewCategory[]   // top 3 most received
  // Dispute tracking
  pendingDisputeCount: number
  // Perks unlocked
  unlockedPerks: SparkPerk[]
  // Score history (last 10 changes)
  history: ScoreHistoryEntry[]
  lastUpdated: number
}

export interface ScoreHistoryEntry {
  delta: number             // +/- change
  reason: string            // e.g. "New review received"
  timestamp: number
}

// ─── Perks System ─────────────────────────────────────────────────────────────

export type SparkPerk =
  | 'vibe_recognition'      // unlocks at 60
  | 'reputation_visible'    // unlocks at 70
  | 'glow_border'           // unlocks at 80
  | 'expanded_likes'        // 2x daily like limit — unlocks at 85
  | 'early_features'        // beta access — unlocks at 95

export interface SparkPerkMeta {
  id: SparkPerk
  label: string
  description: string
  icon: string              // empty string = no icon rendered
  pointsRequired: number
}

export const SPARK_PERKS: SparkPerkMeta[] = [
  {
    id: 'vibe_recognition',
    label: 'Vibe recognition',
    description: 'Your vibe check responses shape your score — honesty here compounds over time.',
    icon: '',
    pointsRequired: 60,
  },
  {
    id: 'reputation_visible',
    label: 'Reputation signal',
    description: 'Matches can see you show up consistently — your engagement speaks for itself.',
    icon: '',
    pointsRequired: 70,
  },
  {
    id: 'glow_border',
    label: 'Glow border',
    description: 'A glow activates on your profile — a signal others notice without being told why.',
    icon: '',
    pointsRequired: 80,
  },
  {
    id: 'expanded_likes',
    label: 'Expanded likes',
    description: '2× your daily like limit — earned through how you show up, not what you pay.',
    icon: '',
    pointsRequired: 85,
  },
  {
    id: 'early_features',
    label: 'Early access',
    description: 'First to try new features before anyone else.',
    icon: '',
    pointsRequired: 95,
  },
]

// ─── Tier Metadata ─────────────────────────────────────────────────────────────

export const TIER_META: Record<ZyloveScoreTier, {
  label: string; emoji: string; color: string; minScore: number; description: string
}> = {
  new:      { label: 'New',      emoji: '🌱', color: '#888',    minScore: 0,   description: 'Building your reputation' },
  building: { label: 'Building', emoji: '📈', color: '#BA7517', minScore: 40,  description: 'Getting there — keep engaging' },
  good:     { label: 'Good',     emoji: '👍', color: '#639922', minScore: 60,  description: 'Solid connector' },
  great:    { label: 'Great',    emoji: '⭐', color: '#1D9E75', minScore: 75,  description: 'Consistently quality interactions' },
  trusted:  { label: 'Trusted',  emoji: '🛡', color: '#7F77DD', minScore: 85,  description: 'One of the best on the app' },
  elite:    { label: 'Elite',    emoji: '✦',  color: '#D4537E', minScore: 95,  description: 'Exceptional — top 1% of connectors' },
}

export function scoreToTier(score: number, reviewCount: number): ZyloveScoreTier {
  if (reviewCount < 5) return 'new'
  if (score >= 95) return 'elite'
  if (score >= 85) return 'trusted'
  if (score >= 75) return 'great'
  if (score >= 60) return 'good'
  return 'building'
}

export function getUnlockedPerks(score: number, _reviewCount?: number): SparkPerk[] {
  return SPARK_PERKS.filter(p => score >= p.pointsRequired).map(p => p.id)
}

// ─── Score Calculation ────────────────────────────────────────────────────────

export function computeScoreDelta(categories: ReviewCategory[]): number {
  const meta = Object.fromEntries(REVIEW_CATEGORIES.map(c => [c.id, c]))
  const rawDelta = categories.reduce((sum, cat) => sum + (meta[cat]?.weight ?? 0), 0)
  // Normalize to max possible delta for the given number of categories
  const maxPositive = Math.max(...REVIEW_CATEGORIES.map(c => c.weight))
  const normalized = rawDelta / (categories.length * maxPositive)
  // Clamp to [-10, +10] per review
  return Math.max(-10, Math.min(10, Math.round(normalized * 10)))
}

// Rolling weighted average — recent reviews matter more
export function computeNewScore(currentScore: number, delta: number, reviewCount: number): number {
  const weight = Math.min(reviewCount, 20)  // caps influence of very old reviews
  const newScore = (currentScore * weight + (50 + delta * 5)) / (weight + 1)
  return Math.max(0, Math.min(100, Math.round(newScore)))
}
