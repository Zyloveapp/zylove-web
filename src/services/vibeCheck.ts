import { doc, getDoc, onSnapshot, Timestamp, type Unsubscribe } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { PLAY_PROMPTS, SPARK_PROMPTS, UNIVERSAL_PROMPTS, type PromptAnswer } from '../types/profile'

// Mirrors mobile's vibeCheck.ts. Ratings go through the recordVibeRating
// callable; nothing about a rating is ever shown to the rated person except
// the warm signal from 'loving_it'.
export type VibeRating = 'loving_it' | 'alright' | 'meh'

export function recordVibeRating(matchId: string, otherUid: string, rating: VibeRating): Promise<unknown> {
  return httpsCallable<{ matchId: string; otherUid: string; rating: VibeRating }, { success: true }>(
    functions,
    'recordVibeRating',
  )({ matchId, otherUid, rating })
}

// ─── Trigger ─────────────────────────────────────────────────────────────────

const MIN_MESSAGES = 6
const MIN_FROM_EACH = 2
const COOLDOWN_MS = 24 * 60 * 60 * 1000

// Milestones: 10, 25, 50, then every 50 (100, 150, ...) — same as mobile.
export function nextVibeCheckMilestone(lastFiredAt: number): number {
  if (lastFiredAt < 10) return 10
  if (lastFiredAt < 25) return 25
  if (lastFiredAt < 50) return 50
  return Math.floor(lastFiredAt / 50) * 50 + 50
}

export function shouldTriggerVibeCheck(senderIds: string[], uid: string, matchId: string): boolean {
  const count = senderIds.length
  if (count < MIN_MESSAGES) return false
  if (count < nextVibeCheckMilestone(lastFiredCount(matchId))) return false
  const mine = senderIds.filter((s) => s === uid).length
  if (mine < MIN_FROM_EACH || count - mine < MIN_FROM_EACH) return false
  const ratedAt = lastRatedAt(matchId)
  return ratedAt === null || Date.now() - ratedAt >= COOLDOWN_MS
}

// ─── localStorage ────────────────────────────────────────────────────────────
// Storage failures fall back to "never fired / never rated"; the server
// enforces the 24h rating cooldown regardless.

function readNumber(key: string): number | null {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function writeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // Storage unavailable — the prompt may repeat next visit.
  }
}

function lastFiredCount(matchId: string): number {
  return readNumber(`zylove_vibecheck_${matchId}`) ?? 0
}

function lastRatedAt(matchId: string): number | null {
  return readNumber(`zylove_vibecheck_rated_${matchId}`)
}

export function markVibeCheckFired(matchId: string, messageCount: number): void {
  writeNumber(`zylove_vibecheck_${matchId}`, messageCount)
}

export function markVibeCheckRated(matchId: string): void {
  writeNumber(`zylove_vibecheck_rated_${matchId}`, Date.now())
}

// ─── Mutual vibe ─────────────────────────────────────────────────────────────
// recordVibeRating stamps matches/{id}.mutualVibeAt when both people's
// latest rating is "Loving it". Each stamp is celebrated once per browser.

export function subscribeMutualVibe(matchId: string, onChange: (at: number | null) => void): Unsubscribe {
  return onSnapshot(
    doc(db, 'matches', matchId),
    (snap) => {
      const at: unknown = snap.data()?.mutualVibeAt
      onChange(at instanceof Timestamp ? at.toMillis() : null)
    },
    () => onChange(null),
  )
}

export function mutualVibeCelebrated(matchId: string, at: number): boolean {
  const seen = readNumber(`zylove_vibe_celebrated_${matchId}`)
  return seen !== null && seen >= at
}

export function markMutualVibeCelebrated(matchId: string, at: number): void {
  writeNumber(`zylove_vibe_celebrated_${matchId}`, at)
}

// ─── Openers ─────────────────────────────────────────────────────────────────

const PROMPT_TEXT = new Map([...UNIVERSAL_PROMPTS, ...SPARK_PROMPTS, ...PLAY_PROMPTS].map((p) => [p.id, p.text]))

const FALLBACK_OPENERS = [
  "What's something you've been looking forward to this week?",
  'What does a perfect low-key evening look like for you?',
  "What's the best thing that happened to you recently?",
]

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

// Three short openers built from the partner's prompt answers and bio,
// topped up with generic ones. No AI call — the "Need a spark?" nudge does that.
export async function loadOpeners(partnerUid: string): Promise<string[]> {
  const openers: string[] = []
  try {
    const snap = await getDoc(doc(db, 'users', partnerUid))
    const data = snap.data() ?? {}
    const answers: unknown = data.promptAnswers
    if (Array.isArray(answers)) {
      for (const a of answers as Partial<PromptAnswer>[]) {
        if (typeof a?.answer !== 'string' || !a.answer.trim()) continue
        const prompt = typeof a.promptId === 'string' ? PROMPT_TEXT.get(a.promptId) : undefined
        openers.push(
          prompt
            ? `You said "${clip(a.answer, 60)}" for "${prompt}" — what's the story there?`
            : `"${clip(a.answer, 60)}" — tell me more about that.`,
        )
        if (openers.length === 2) break
      }
    }
    if (typeof data.bio === 'string' && data.bio.trim()) {
      openers.push(`Your bio caught my eye — what's the part of "${clip(data.bio, 50)}" people don't expect?`)
    }
  } catch {
    // Fall through to the generic openers.
  }
  for (const f of FALLBACK_OPENERS) {
    if (openers.length >= 3) break
    openers.push(f)
  }
  return openers.slice(0, 3)
}
