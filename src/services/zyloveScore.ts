import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import type { ReviewCategory, ZyloveScoreTier } from '../types/zyloveScore'

// users/{uid}/zyloveScore/current — written only by the submitReview callable,
// readable only by its owner.
export interface ScoreDetail {
  score: number
  tier: ZyloveScoreTier
  reviewCount: number
  positiveCount: number
  negativeCount: number
  flagCount: number
  topPositiveCategories: ReviewCategory[]
}

const TIERS: ZyloveScoreTier[] = ['new', 'building', 'good', 'great', 'trusted', 'elite']

// Mobile's default for a user nobody has reviewed yet.
export const DEFAULT_SCORE: ScoreDetail = {
  score: 50,
  tier: 'new',
  reviewCount: 0,
  positiveCount: 0,
  negativeCount: 0,
  flagCount: 0,
  topPositiveCategories: [],
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// Emits DEFAULT_SCORE when the doc doesn't exist yet.
export function subscribeScore(
  uid: string,
  onChange: (score: ScoreDetail) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, `users/${uid}/zyloveScore/current`),
    (snap) => {
      const data = snap.data()
      if (!data || typeof data.score !== 'number') return onChange(DEFAULT_SCORE)
      onChange({
        score: data.score,
        tier: TIERS.includes(data.tier) ? data.tier : 'new',
        reviewCount: count(data.reviewCount),
        positiveCount: count(data.positiveCount),
        negativeCount: count(data.negativeCount),
        flagCount: count(data.flagCount),
        topPositiveCategories: Array.isArray(data.topPositiveCategories) ? data.topPositiveCategories : [],
      })
    },
    onError,
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
