import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import type { ZyloveScoreTier } from '../types/zyloveScore'

// users/{uid}/zyloveScore/current — written only by the submitReview callable,
// readable only by its owner.
export interface ScoreDetail {
  score: number
  tier: ZyloveScoreTier
  reviewCount: number
  positiveCount: number
  negativeCount: number
  flagCount: number
  topPositiveCategories: string[]
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
        topPositiveCategories: Array.isArray(data.topPositiveCategories)
          ? data.topPositiveCategories.filter((c: unknown): c is string => typeof c === 'string')
          : [],
      })
    },
    onError,
  )
}

export async function submitReview(matchId: string, reviewedUid: string, categories: string[]): Promise<void> {
  await httpsCallable<{ matchId: string; reviewedUid: string; categories: string[] }, { success: true }>(
    functions,
    'submitReview',
  )({ matchId, reviewedUid, categories })
}

// ─── Review prompts ──────────────────────────────────────────────────────────
// Reviews are never requested mid-conversation. Two triggers:
//   1. The match ended (blocked, unmatched, or deleted by mobile's unmatch) —
//      ReviewPrompter, app-wide.
//   2. The conversation went cold: 30+ days quiet after 10+ messages — ChatView.

export const COLD_MIN_MESSAGES = 10
const COLD_AFTER_MS = 30 * 24 * 60 * 60 * 1000

export function isBotUid(uid: string): boolean {
  return uid.startsWith('zbot-') || uid.startsWith('seed-')
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    // Storage unavailable — don't risk asking on every visit.
    return true
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, '1')
  } catch {
    // Storage unavailable — the prompt may show again next visit.
  }
}

// Set on submit and on dismissing the ended-match prompt: it asks once.
export const reviewed = (matchId: string) => readFlag(`zylove_reviewed_${matchId}`)
export const markReviewed = (matchId: string) => writeFlag(`zylove_reviewed_${matchId}`)
export const coldReviewShown = (matchId: string) => readFlag(`zylove_cold_review_${matchId}`)
export const markColdReviewShown = (matchId: string) => writeFlag(`zylove_cold_review_${matchId}`)

export function conversationCold(lastMessageAt: number | null, messageCount: number): boolean {
  return messageCount >= COLD_MIN_MESSAGES && lastMessageAt !== null && Date.now() - lastMessageAt >= COLD_AFTER_MS
}

// Matches seen on this device, so ones that vanish (mobile's unmatch deletes
// the doc) can still be offered for review on the next visit.
export interface KnownMatch {
  partnerUid: string
  name: string
  hadMessages: boolean
}

function knownKey(uid: string): string {
  return `zylove_known_matches_${uid}`
}

export function loadKnownMatches(uid: string): Record<string, KnownMatch> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(knownKey(uid)) ?? '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, KnownMatch>) : {}
  } catch {
    return {}
  }
}

export function saveKnownMatches(uid: string, known: Record<string, KnownMatch>): void {
  try {
    localStorage.setItem(knownKey(uid), JSON.stringify(known))
  } catch {
    // Storage unavailable — vanished matches just won't be offered for review.
  }
}
