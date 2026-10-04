import { deleteField, doc, getDoc, onSnapshot, Timestamp, updateDoc, type Unsubscribe } from 'firebase/firestore'
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
// Cadence by mode: Play conversations move faster, so they're checked sooner
// and more often.
//   Spark: 10, 25, 50, then every 50 · 24h between ratings
//   Play:  8, 20, 40, then every 40  · 12h between ratings
// recordVibeRating enforces the same cooldowns server-side.

export type VibeMode = 'spark' | 'play'

const CADENCE: Record<VibeMode, { milestones: number[]; every: number; cooldownMs: number }> = {
  spark: { milestones: [10, 25, 50], every: 50, cooldownMs: 24 * 60 * 60 * 1000 },
  play: { milestones: [8, 20, 40], every: 40, cooldownMs: 12 * 60 * 60 * 1000 },
}

const MIN_MESSAGES = 6
const MIN_FROM_EACH = 2

// The match doc's mode ('entanglement' is an older name for Play).
export function vibeModeOf(mode: unknown): VibeMode {
  return mode === 'play' || mode === 'entanglement' ? 'play' : 'spark'
}

export function nextVibeCheckMilestone(lastFiredAt: number, mode: VibeMode): number {
  const { milestones, every } = CADENCE[mode]
  const next = milestones.find((m) => lastFiredAt < m)
  return next ?? Math.floor(lastFiredAt / every) * every + every
}

// This user's vibe-check state for one match: the message count the last
// check fired at, and when they last rated (ms).
export interface VibeCheckState {
  lastThreshold: number
  lastRatedAt: number | null
}

export function shouldTriggerVibeCheck(senderIds: string[], uid: string, state: VibeCheckState, mode: VibeMode): boolean {
  const count = senderIds.length
  if (count < MIN_MESSAGES) return false
  if (count < nextVibeCheckMilestone(state.lastThreshold, mode)) return false
  const mine = senderIds.filter((s) => s === uid).length
  if (mine < MIN_FROM_EACH || count - mine < MIN_FROM_EACH) return false
  return state.lastRatedAt === null || Date.now() - state.lastRatedAt >= CADENCE[mode].cooldownMs
}

// ─── State: matches/{id}.vibeCheckState_{uid} ───────────────────────────────
// { lastThreshold, lastRatedAt } on the match doc, so every device agrees.
// lastThreshold is written here when a check fires; lastRatedAt by
// recordVibeRating. Older matches kept both in this browser's localStorage:
// read as a fallback, copied up once, then cleared.

const stateField = (uid: string) => `vibeCheckState_${uid}`
const legacyFiredKey = (matchId: string) => `zylove_vibecheck_${matchId}`
const legacyRatedKey = (matchId: string) => `zylove_vibecheck_rated_${matchId}`

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
    // Storage unavailable.
  }
}

function clearLegacy(matchId: string): void {
  try {
    localStorage.removeItem(legacyFiredKey(matchId))
    localStorage.removeItem(legacyRatedKey(matchId))
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

function toMillis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis()
  return typeof v === 'number' && v > 0 ? v : null
}

// Live state from the match doc, merged with any legacy localStorage values
// (the later of each wins). Legacy values are copied to the doc once and
// cleared. A read error reports "never fired, never rated", as before.
export function subscribeVibeCheckState(matchId: string, uid: string, onChange: (state: VibeCheckState) => void): Unsubscribe {
  let migrated = false
  return onSnapshot(
    doc(db, 'matches', matchId),
    (snap) => {
      const raw: unknown = snap.data()?.[stateField(uid)]
      const remote = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
      const remoteThreshold = typeof remote.lastThreshold === 'number' ? remote.lastThreshold : 0
      const remoteRated = toMillis(remote.lastRatedAt)
      const localThreshold = readNumber(legacyFiredKey(matchId)) ?? 0
      const localRated = readNumber(legacyRatedKey(matchId))
      const state: VibeCheckState = {
        lastThreshold: Math.max(remoteThreshold, localThreshold),
        lastRatedAt: Math.max(remoteRated ?? 0, localRated ?? 0) || null,
      }
      onChange(state)

      if (!migrated && (localThreshold > 0 || localRated !== null)) {
        migrated = true
        const up: Record<string, number> = {}
        if (localThreshold > remoteThreshold) up[`${stateField(uid)}.lastThreshold`] = localThreshold
        if (localRated !== null && localRated > (remoteRated ?? 0)) up[`${stateField(uid)}.lastRatedAt`] = localRated
        const write = Object.keys(up).length > 0 ? updateDoc(doc(db, 'matches', matchId), up) : Promise.resolve()
        write.then(() => clearLegacy(matchId)).catch(() => {})
      }
    },
    () => onChange({ lastThreshold: 0, lastRatedAt: null }),
  )
}

// A check fired at this message count. If the write fails, this browser
// remembers it (the fallback) so the prompt doesn't repeat here.
export async function markVibeCheckFired(matchId: string, uid: string, messageCount: number): Promise<void> {
  try {
    await updateDoc(doc(db, 'matches', matchId), { [`${stateField(uid)}.lastThreshold`]: messageCount })
    clearLegacy(matchId)
  } catch {
    writeNumber(legacyFiredKey(matchId), messageCount)
  }
}

// recordVibeRating stamps lastRatedAt on the doc; this only drops any
// legacy local copy so it can't outlive the server's value.
export function markVibeCheckRated(matchId: string): void {
  try {
    localStorage.removeItem(legacyRatedKey(matchId))
  } catch {
    // ignore
  }
}

// Testing only (admin console: window.__resetVibeCheck): clears this user's
// state for the match, on the doc and in this browser, so the next check
// shows on reopening the chat. Admins also skip the server's rating cooldown.
export async function resetVibeCheckForTesting(matchId: string, uid: string): Promise<void> {
  clearLegacy(matchId)
  await updateDoc(doc(db, 'matches', matchId), { [stateField(uid)]: deleteField() })
}

// ─── Mutual vibe ─────────────────────────────────────────────────────────────
// recordVibeRating stamps matches/{id}.mutualVibeAt when both people's
// latest rating is "Loving it". The live listener also reads both ratings
// directly, so the partner sees it the moment the second rating lands even
// if the stamp is late or missing. Each moment is celebrated once per user
// per browser.

const MUTUAL_VIBE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function millisOf(v: unknown): number | null {
  return v instanceof Timestamp ? v.toMillis() : null
}

// When the vibe became mutual: the server stamp, else both latest ratings
// "Loving it" within a week of each other (the later one's time).
function mutualAt(m: Record<string, unknown>, uid: string, partnerUid: string): number | null {
  const stamped = millisOf(m.mutualVibeAt)
  if (stamped !== null) return stamped
  const mine = millisOf(m[`lastVibeRatedAt_${uid}`])
  const theirs = millisOf(m[`lastVibeRatedAt_${partnerUid}`])
  if (m[`lastVibeRating_${uid}`] !== 'loving_it' || m[`lastVibeRating_${partnerUid}`] !== 'loving_it') return null
  if (mine === null || theirs === null || Math.abs(mine - theirs) > MUTUAL_VIBE_WINDOW_MS) return null
  return Math.max(mine, theirs)
}

// Live; re-subscribes after an error so a dropped listener can't miss it.
export function subscribeMutualVibe(
  matchId: string,
  uid: string,
  partnerUid: string,
  onChange: (at: number | null) => void,
): Unsubscribe {
  let unsub: Unsubscribe = () => {}
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const listen = () => {
    unsub = onSnapshot(
      doc(db, 'matches', matchId),
      (snap) => onChange(mutualAt(snap.data() ?? {}, uid, partnerUid)),
      () => {
        if (!stopped) retry = setTimeout(listen, 3000)
      },
    )
  }
  listen()
  return () => {
    stopped = true
    clearTimeout(retry)
    unsub()
  }
}

// Per user, so two accounts tested in one browser each get their own moment.
const celebratedKey = (matchId: string, uid: string) => `zylove_vibe_celebrated_${uid}_${matchId}`

export function mutualVibeCelebrated(matchId: string, uid: string, at: number): boolean {
  const seen = readNumber(celebratedKey(matchId, uid))
  return seen !== null && seen >= at
}

// Marked with the later of the moment and now, so the server stamp landing
// just after the ratings-based detection doesn't celebrate a second time.
export function markMutualVibeCelebrated(matchId: string, uid: string, at: number): void {
  writeNumber(celebratedKey(matchId, uid), Math.max(at, Date.now()))
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
