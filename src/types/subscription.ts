// src/types/subscription.ts
//
// Zylove subscription tiers — 3 levels.
//
// FREE          — heavily restricted. Enough to understand the value, not enough
//                 to enjoy it. Every limit is a conversion moment.
//
// SPARK+        — serious dating premium. $9.99/mo. 7-day free trial.
//                 Everything a committed dater needs. No Play features.
//                 AI profile feedback + conversation sparks unlocked.
//
// ELITE         — everything. $19.99/mo. 14-day free trial.
//                 Spark+ features + Play mode + exclusive Elite perks.
//                 Play mode is Elite only. AI photo scanning unlocked.
//                 Free Play trial available to existing Spark+ users
//                 after qualifying time on app.
//
// AI gating summary:
//   Women         → all AI features free (enforced via hasAiFeature helper)
//   Men / other   → aiProfileFeedback + aiConversationSparks at Spark+
//                   aiPhotoScanning at Elite only

export type SubscriptionTier = 'free' | 'spark_plus' | 'elite'

export interface TierFeatures {
  // Discovery
  dailyLikes: number
  canSeeWhoLikesYou: boolean
  yourFiveActive: boolean
  canRefreshYourFive: boolean
  discoveryRadius: number         // miles — free = 10mi, paid = unlimited (-1)
  advancedFilters: boolean

  // Matching
  priorityPlacement: boolean
  profileBoostsPerMonth: number

  // Messaging
  canMessageFirst: boolean
  readReceipts: boolean
  photoSharing: boolean

  // Play features
  playModeAccess: boolean
  playProfileActive: boolean
  unlimitedPlayLikes: boolean
  selfDestructPhotos: boolean

  // Insights
  canSeeCompatibilityScore: boolean   // headline % number is visible at all
  fullScorecardAccess: boolean        // category breakdown rows / commons / challenges
  bilateralBreakdown: boolean         // Elite — Deep fit pill + combined-score callout prominent
  profileViewers: boolean
  likeAnalytics: boolean

  // AI features
  // aiProfileFeedback    — full AI profile coaching (Spark+ for men, free for women)
  // aiConversationSparks — in-chat AI suggestions (Spark+ for men, free for women)
  // zyloveScore          — Zylove Score display (Spark+ for men, free for women)
  // zyloveScoreInsights  — full score breakdown (Elite for men, free for women)
  // aiPhotoScanning      — photo quality analysis via Claude vision (Elite for men, free for women)
  //                        requires separate user opt-in consent before activation
  aiProfileFeedback: boolean
  aiConversationSparks: boolean
  zyloveScore: boolean
  zyloveScoreInsights: boolean
  aiPhotoScanning: boolean

  // Elite extras
  incognitoMode: boolean
  instantViewNotifications: boolean
  prioritySupportAccess: boolean
  earlyFeatureAccess: boolean
}

// ─── Feature definitions per tier ─────────────────────────────────────────────

export const TIER_FEATURES: Record<SubscriptionTier, TierFeatures> = {
  free: {
    dailyLikes:               8,
    canSeeWhoLikesYou:        false,
    yourFiveActive:           false,
    canRefreshYourFive:       false,
    discoveryRadius:          10,
    advancedFilters:          false,
    priorityPlacement:        false,
    profileBoostsPerMonth:    0,
    canMessageFirst:          false,
    readReceipts:             false,
    photoSharing:             false,
    playModeAccess:           false,
    playProfileActive:        false,
    unlimitedPlayLikes:       false,
    selfDestructPhotos:       false,
    canSeeCompatibilityScore: true,   // headline number visible to all tiers per design
    fullScorecardAccess:      false,
    bilateralBreakdown:       false,
    profileViewers:           false,
    likeAnalytics:            false,
    aiProfileFeedback:        false,  // Spark+ for men
    aiConversationSparks:     false,  // Spark+ for men
    zyloveScore:              false,  // Spark+ for men
    zyloveScoreInsights:      false,  // Elite for men
    aiPhotoScanning:          false,  // Elite for men, requires opt-in
    incognitoMode:            false,
    instantViewNotifications: false, // TODO: post-TestFlight — push infrastructure pending
    prioritySupportAccess:    false,
    earlyFeatureAccess:       false,
  },

  spark_plus: {
    dailyLikes:               -1,    // unlimited
    canSeeWhoLikesYou:        true,
    yourFiveActive:           true,
    canRefreshYourFive:       true,
    discoveryRadius:          -1,    // unlimited
    advancedFilters:          true,
    priorityPlacement:        true,
    profileBoostsPerMonth:    1,
    canMessageFirst:          false, // still requires match
    readReceipts:             true,
    photoSharing:             true,
    playModeAccess:           false, // Play = Elite only
    playProfileActive:        false,
    unlimitedPlayLikes:       false,
    selfDestructPhotos:       false,
    canSeeCompatibilityScore: true,
    fullScorecardAccess:      true,
    bilateralBreakdown:       false,
    profileViewers:           true,
    likeAnalytics:            false,
    aiProfileFeedback:        true,  // unlocked at Spark+
    aiConversationSparks:     true,
    zyloveScore:              true,
    zyloveScoreInsights:      false, // Elite only
    aiPhotoScanning:          false, // Elite only
    incognitoMode:            false,
    instantViewNotifications: false, // TODO: post-TestFlight — push infrastructure pending
    prioritySupportAccess:    false,
    earlyFeatureAccess:       false,
  },

  elite: {
    dailyLikes:               -1,
    canSeeWhoLikesYou:        true,
    yourFiveActive:           true,
    canRefreshYourFive:       true,
    discoveryRadius:          -1,
    advancedFilters:          true,
    priorityPlacement:        true,
    profileBoostsPerMonth:    5,
    canMessageFirst:          false,
    readReceipts:             true,
    photoSharing:             true,
    playModeAccess:           true,
    playProfileActive:        true,
    unlimitedPlayLikes:       true,
    selfDestructPhotos:       true,
    canSeeCompatibilityScore: true,
    fullScorecardAccess:      true,
    bilateralBreakdown:       true,
    profileViewers:           true,
    likeAnalytics:            true,
    aiProfileFeedback:        true,
    aiConversationSparks:     true,
    zyloveScore:              true,
    zyloveScoreInsights:      true,
    aiPhotoScanning:          true,  // Elite only, requires opt-in
    incognitoMode:            true,
    instantViewNotifications: true, // TODO: post-TestFlight — push infrastructure pending
    prioritySupportAccess:    true,
    earlyFeatureAccess:       true,
  },
}

// ─── Pricing and trial config ──────────────────────────────────────────────────

export interface TierPricing {
  monthlyPrice: string
  trialDays: number
  revenueCatMonthlyId: string  // App Store Connect / Google Play product ID
  revenueCatEntitlement: string  // RC dashboard entitlement key checked by webhook
}

export const TIER_PRICING: Record<Exclude<SubscriptionTier, 'free'>, TierPricing> = {
  spark_plus: {
    monthlyPrice:          '$14.99',
    trialDays:             7,
    revenueCatMonthlyId:   'zylove_spark_plus_monthly',
    revenueCatEntitlement: 'spark_plus',
  },
  elite: {
    monthlyPrice:          '$24.99',
    trialDays:             7,
    revenueCatMonthlyId:   'zylove_elite_monthly',
    revenueCatEntitlement: 'elite',
  },
}

// ─── Tier metadata for UI ──────────────────────────────────────────────────────

export const TIER_META: Record<SubscriptionTier, {
  name: string
  emoji: string
  tagline: string
  color: string
  badge: string
}> = {
  free: {
    name:    'Free',
    emoji:   '🌱',
    tagline: 'Get started',
    color:   '#888',
    badge:   'Free',
  },
  spark_plus: {
    name:    'Spark+',
    emoji:   '🔵',
    tagline: 'Serious dating, seriously good',
    color:   '#1B4FD8',
    badge:   'Spark+',
  },
  elite: {
    name:    'Elite',
    emoji:   '✦',
    tagline: 'Everything. Unlimited. Yours.',
    color:   '#6B21A8',
    badge:   'Elite',
  },
}

// ─── Gate check helpers ────────────────────────────────────────────────────────

export function hasFeature(
  tier: SubscriptionTier,
  feature: keyof TierFeatures
): boolean {
  const val = TIER_FEATURES[tier][feature]
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return val !== 0
  return false
}

export function getLimitValue(
  tier: SubscriptionTier,
  feature: keyof TierFeatures
): number {
  const val = TIER_FEATURES[tier][feature]
  if (typeof val === 'number') return val
  return 0
}

export function isUnlimited(
  tier: SubscriptionTier,
  feature: keyof TierFeatures
): boolean {
  return getLimitValue(tier, feature) === -1
}

// ─── AI feature gate ──────────────────────────────────────────────────────────
// Women always have access to all AI features.
// Men and all other gender identities are gated by tier.
// aiProfileFeedback / aiConversationSparks / zyloveScore → Spark+
// aiPhotoScanning / zyloveScoreInsights                  → Elite
// Caller is responsible for also checking photoScanningConsent in Firestore
// before activating aiPhotoScanning.

export function hasAiFeature(
  tier: SubscriptionTier,
  feature: keyof Pick<TierFeatures,
    'aiProfileFeedback' | 'aiConversationSparks' | 'zyloveScore' |
    'zyloveScoreInsights' | 'aiPhotoScanning'
  >,
  genderIdentity: string | undefined
): boolean {
  if (isWomanIdentity(genderIdentity)) return true
  return hasFeature(tier, feature)
}

// Women-only identity check. See feedback.tsx for TODO on hardening this
// server-side once abuse patterns are known.
export function isWomanIdentity(genderIdentity: string | undefined): boolean {
  if (!genderIdentity) return false
  const g = genderIdentity.toLowerCase().trim()
  return g === 'woman' || g === 'cis woman' || g === 'trans_woman'
}
