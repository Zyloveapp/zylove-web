import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'

// Web tier logic. Women and other non-male identities, and founders, are
// Elite for life; men get a 30-day trial (trialEndsAt, set server-side by
// initUserDefaults), then Free until they pay. Mobile still only treats
// woman / trans_woman as Elite — web is the launch surface.

export type Tier = 'elite' | 'spark_plus' | 'trial' | 'free'
export type Feature =
  | 'explore'
  | 'sparks'
  | 'compatibility'
  | 'photo_sharing'
  | 'play_mode'
  | 'zylove_score'
  | 'conversation_starters'
  | 'vibe_check'

export interface TierFields {
  subscriptionTier?: unknown
  trialEndsAt?: unknown
  trialExpired?: unknown
  genderIdentity?: unknown
  isFounder?: unknown
  // Stripe state, written by the stripeWebhook function.
  subscriptionStatus?: unknown
}

// Stored as 'nonbinary'; 'non_binary' accepted too.
const ALWAYS_ELITE_IDENTITIES = ['woman', 'trans_woman', 'nonbinary', 'non_binary', 'genderfluid', 'agender', 'self_describe']

function toDate(v: unknown): Date | null {
  if (v && typeof v === 'object' && 'toDate' in v && typeof v.toDate === 'function') return v.toDate() as Date
  if (typeof v === 'number' || typeof v === 'string') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

function gender(user: TierFields): string {
  const g = Array.isArray(user.genderIdentity) ? user.genderIdentity[0] : user.genderIdentity
  return typeof g === 'string' ? g : ''
}

export function isAlwaysElite(user: TierFields): boolean {
  return ALWAYS_ELITE_IDENTITIES.includes(gender(user)) || user.isFounder === true
}

export function getUserTier(user: TierFields): Tier {
  if (isAlwaysElite(user)) return 'elite'
  if (user.subscriptionTier === 'elite') return 'elite'
  if (user.subscriptionTier === 'spark_plus') return 'spark_plus'
  const endsAt = toDate(user.trialEndsAt)
  if (user.trialExpired !== true && endsAt && endsAt > new Date()) return 'trial'
  return 'free'
}

const ACCESS: Record<Tier, readonly Feature[]> = {
  elite: ['explore', 'sparks', 'compatibility', 'photo_sharing', 'play_mode', 'zylove_score', 'conversation_starters', 'vibe_check'],
  spark_plus: ['explore', 'sparks', 'compatibility', 'photo_sharing', 'conversation_starters', 'vibe_check'],
  trial: ['explore', 'sparks', 'compatibility', 'photo_sharing', 'play_mode', 'zylove_score', 'conversation_starters', 'vibe_check'],
  free: ['explore'],
}

export function canAccess(tier: Tier, feature: Feature): boolean {
  return ACCESS[tier].includes(feature)
}

// 'active' | 'past_due' | 'canceled' | 'unpaid', or null for no subscription.
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'unpaid'

export function getSubscriptionStatus(user: TierFields): SubscriptionStatus | null {
  const s = user.subscriptionStatus
  return s === 'active' || s === 'past_due' || s === 'canceled' || s === 'unpaid' ? s : null
}

// Free because the trial ran out (flagged nightly by checkTrialStatus, or
// its end date has simply passed) — not just "no plan".
export function hasTrialEnded(user: TierFields): boolean {
  if (getUserTier(user) !== 'free') return false
  const endsAt = toDate(user.trialEndsAt)
  return user.trialExpired === true || (endsAt !== null && endsAt <= new Date())
}

export function getDaysLeftInTrial(user: TierFields): number | null {
  const endsAt = toDate(user.trialEndsAt)
  if (!endsAt) return null
  return Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000))
}

export const TRIAL_DAYS = 30

export function subscribeTierFields(uid: string, onChange: (fields: TierFields) => void, onError: () => void): Unsubscribe {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      const d = snap.data() ?? {}
      onChange({
        subscriptionTier: d.subscriptionTier,
        trialEndsAt: d.trialEndsAt,
        trialExpired: d.trialExpired,
        genderIdentity: d.genderIdentity,
        isFounder: d.isFounder,
        subscriptionStatus: d.subscriptionStatus,
      })
    },
    onError,
  )
}
