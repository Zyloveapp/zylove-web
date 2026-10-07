// Post-connection review categories. Mirrored in functions/src/shared/reviewCategories.ts — keep in sync.
//
//   positive — +2 each, applied when the review is submitted (cap +8)
//   neutral  — stored, no score impact
//   negative — −3 each, applied only once the match ends (cap −10)

export type ReviewTone = 'positive' | 'neutral' | 'negative'

export interface ReviewCategoryDef {
  id: string
  label: string
  emoji: string
  tone: ReviewTone
}

export const REVIEW_CATEGORY_DEFS: ReviewCategoryDef[] = [
  { id: 'respectful', label: 'Respectful', emoji: '🌿', tone: 'positive' },
  { id: 'great_conversation', label: 'Great conversation', emoji: '💬', tone: 'positive' },
  { id: 'made_me_feel_safe', label: 'Made me feel safe', emoji: '🛡', tone: 'positive' },
  { id: 'genuine_connection', label: 'Genuine connection', emoji: '💎', tone: 'positive' },
  { id: 'good_listener', label: 'Good listener', emoji: '👂', tone: 'positive' },
  { id: 'kept_it_real', label: 'Kept it real', emoji: '✨', tone: 'positive' },
  { id: 'fun_to_talk_to', label: 'Fun to talk to', emoji: '😂', tone: 'positive' },
  { id: 'emotionally_available', label: 'Emotionally available', emoji: '🤍', tone: 'positive' },
  { id: 'supportive', label: 'Supportive', emoji: '🤝', tone: 'positive' },
  { id: 'followed_through', label: 'Followed through', emoji: '✅', tone: 'positive' },

  { id: 'different_priorities', label: 'Different priorities', emoji: '🧭', tone: 'neutral' },
  { id: 'different_styles', label: 'Different styles', emoji: '🎨', tone: 'neutral' },
  { id: 'lifestyle_gap', label: 'Lifestyle gap', emoji: '🌗', tone: 'neutral' },
  { id: 'didnt_connect', label: "Didn't connect", emoji: '🔌', tone: 'neutral' },
  { id: 'conversation_fizzled', label: 'Conversation fizzled', emoji: '💨', tone: 'neutral' },

  { id: 'pushed_boundaries', label: 'Pushed my boundaries', emoji: '🆘', tone: 'negative' },
  { id: 'inappropriate', label: 'Inappropriate', emoji: '🚨', tone: 'negative' },
  { id: 'felt_unsafe', label: 'I felt unsafe', emoji: '⚠️', tone: 'negative' },
  { id: 'pressured_me', label: 'Pressured me', emoji: '😣', tone: 'negative' },
  { id: 'aggressive', label: 'Aggressive', emoji: '💢', tone: 'negative' },
  { id: 'misleading_profile', label: 'Misleading profile', emoji: '📸', tone: 'negative' },
  { id: 'disrespectful', label: 'Disrespectful', emoji: '🚫', tone: 'negative' },
  { id: 'ghosted', label: 'Ghosted', emoji: '👻', tone: 'negative' },
  { id: 'wasted_my_time', label: 'Wasted my time', emoji: '⏳', tone: 'negative' },
]

export const REVIEW_TONE = new Map(REVIEW_CATEGORY_DEFS.map((c) => [c.id, c.tone]))

// Report-only categories (T&S Phase 2): offered when reporting, never in a
// review, never part of the Zylove Score. "scam": 2 reports within 30 days
// from unlinked 48h+ accounts suspend pending review (functions/src/scamReports.ts).
export const REPORT_ONLY_CATEGORY_DEFS: ReviewCategoryDef[] = [
  { id: 'scam', label: 'Scam or asked for money', emoji: '💸', tone: 'negative' },
]
export const REPORT_ONLY_IDS = new Set(REPORT_ONLY_CATEGORY_DEFS.map((c) => c.id))

export const POINTS_PER_POSITIVE = 2
export const POINTS_PER_NEGATIVE = -3
export const MAX_POSITIVE_DELTA = 8
export const MAX_NEGATIVE_DELTA = -10

// Safety categories counted in the Zylove Score's Flags stat.
export const FLAG_CATEGORY_IDS = ['pushed_boundaries', 'inappropriate', 'felt_unsafe', 'aggressive']

// Moderation fires at submit time, before any deferral. windowDays null = all time.
export const MODERATION_RULES: { category: string; threshold: number; windowDays: number | null; urgent: boolean }[] = [
  { category: 'pushed_boundaries', threshold: 2, windowDays: 30, urgent: false },
  { category: 'inappropriate', threshold: 2, windowDays: null, urgent: false },
  { category: 'felt_unsafe', threshold: 1, windowDays: null, urgent: true },
  { category: 'aggressive', threshold: 1, windowDays: null, urgent: true },
]
