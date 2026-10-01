import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { TIER_FEATURES, hasAiFeature, type SubscriptionTier } from '../types/subscription'
import type { ReviewCategory, ZyloveScoreTier } from '../types/zyloveScore'

// users/{uid}/zyloveScore/current — written only by the submitReview callable,
// readable only by its owner.
export interface ScoreSummary {
  score: number
  tier: ZyloveScoreTier
  reviewCount: number
  history: number[] // scores after each recent review, oldest first
}

const TIERS: ZyloveScoreTier[] = ['new', 'building', 'good', 'great', 'trusted', 'elite']

export function subscribeScore(
  uid: string,
  onChange: (score: ScoreSummary | null) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, `users/${uid}/zyloveScore/current`),
    (snap) => {
      const data = snap.data()
      if (!data || typeof data.score !== 'number') return onChange(null)
      const history: unknown = data.history
      onChange({
        score: data.score,
        tier: TIERS.includes(data.tier) ? data.tier : 'new',
        reviewCount: typeof data.reviewCount === 'number' ? data.reviewCount : 0,
        history: Array.isArray(history)
          ? history.map((h: { score?: unknown }) => h?.score).filter((s): s is number => typeof s === 'number')
          : [],
      })
    },
    onError,
  )
}

// Zylove Score is free for women, Spark+ and up for everyone else.
export function subscribeScoreAccess(uid: string, onChange: (unlocked: boolean) => void): Unsubscribe {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      const data = snap.data() ?? {}
      // Profile docs can carry tiers this table doesn't know ('play_pass').
      const tier: SubscriptionTier = data.subscriptionTier in TIER_FEATURES ? data.subscriptionTier : 'free'
      // genderIdentity is a string in Spark onboarding, an array in Play.
      const gender: unknown = Array.isArray(data.genderIdentity) ? data.genderIdentity[0] : data.genderIdentity
      onChange(hasAiFeature(tier, 'zyloveScore', typeof gender === 'string' ? gender : undefined))
    },
    () => onChange(false),
  )
}

export async function submitReview(matchId: string, reviewedUid: string, categories: ReviewCategory[]): Promise<void> {
  await httpsCallable<{ matchId: string; reviewedUid: string; categories: ReviewCategory[] }, { success: true }>(
    functions,
    'submitReview',
  )({ matchId, reviewedUid, categories })
}

// ─── Review prompt ───────────────────────────────────────────────────────────

export const REVIEW_MIN_MESSAGES = 20
// A conversation counts as ended when nobody has written for a day.
const ENDED_AFTER_MS = 24 * 60 * 60 * 1000

function shownKey(matchId: string): string {
  return `zylove_review_shown_${matchId}`
}

export function reviewPromptShown(matchId: string): boolean {
  try {
    return localStorage.getItem(shownKey(matchId)) === '1'
  } catch {
    // Storage unavailable — don't risk asking on every visit.
    return true
  }
}

export function markReviewPromptShown(matchId: string): void {
  try {
    localStorage.setItem(shownKey(matchId), '1')
  } catch {
    // Storage unavailable — the prompt may show again next visit.
  }
}

export function conversationEnded(lastMessageAt: number | null): boolean {
  return lastMessageAt !== null && Date.now() - lastMessageAt > ENDED_AFTER_MS
}
