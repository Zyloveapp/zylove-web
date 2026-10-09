import { getFirestore, FieldValue, type DocumentData, type DocumentReference } from 'firebase-admin/firestore'
import { playStatus } from './playAccess'
import { ensurePlayId, playPairKey } from './playIds'
import { publicPlayTier1, SCORE_ENGINE_VERSION } from './legacy/scoring'

// A Play pair's state — its Play scores and its Play likes — lives in
// playPairData/{pA_pB} (F-065): server-only, keyed by the two Play IDs, never
// under the uid pair. A Play tap or like doesn't create or touch
// pairs/{uidA_uidB}, which a participant could test for. The doc:
//   users          [uidA, uidB] sorted — internal, for the server's queries
//   likedBy        uids who liked the other in Play (likes.ts)
//   playScore, playBreakdown, tier1Play, scoredAt
// Scores are computed only when both people have Play access — a Spark-only
// user's tap never produces Play data.

export const PLAY_PAIR_FIELDS = ['playScore', 'playBreakdown', 'tier1Play'] as const

export async function playPairDataRef(a: string, b: string): Promise<DocumentReference> {
  const [pa, pb] = await Promise.all([ensurePlayId(a), ensurePlayId(b)])
  return getFirestore().doc(`playPairData/${playPairKey(pa, pb)}`)
}

export const playPairUsers = (a: string, b: string): string[] => [a, b].sort()

// Before F-065 the scores were in pairs/{uidA_uidB}/modes/play (moved by
// scripts/migrate-f065.mjs; read as a fallback until then).
const legacyScoresRef = (a: string, b: string): DocumentReference => getFirestore().doc(`pairs/${playPairUsers(a, b).join('_')}/modes/play`)

export async function bothHavePlay(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([playStatus(a), playStatus(b)])
  return sa.access && sb.access
}

// The Play fields of a scoring result, ready to store (tier1Play only when
// set; F-098: its public shape only — the archetype without confidence).
export function playFields(score: number, breakdown: unknown, tier1: unknown): DocumentData {
  const tier1Play = publicPlayTier1(tier1)
  return { playScore: score, playBreakdown: breakdown, ...(tier1Play ? { tier1Play } : {}) }
}

// The merge write for a pair's Play scores. A result with no archetype
// deletes the stored tier1Play — merging without it kept the old label.
export function playScoresWrite(a: string, b: string, fields: DocumentData): DocumentData {
  return { users: playPairUsers(a, b), ...fields, tier1Play: fields.tier1Play ?? FieldValue.delete(), scoredAt: FieldValue.serverTimestamp() }
}

// Stores the pair's Play scores, or with null removes them (the likes stay).
export async function setPlayScores(a: string, b: string, fields: DocumentData | null): Promise<void> {
  const ref = await playPairDataRef(a, b)
  if (fields) {
    await ref.set(playScoresWrite(a, b, fields), { merge: true })
    return
  }
  const gone = Object.fromEntries([...PLAY_PAIR_FIELDS, 'scoredAt'].map((k) => [k, FieldValue.delete()]))
  if ((await ref.get()).exists) await ref.update(gone)
}

// The pair's Play scores, if any.
export async function loadPlayScores(a: string, b: string): Promise<DocumentData | undefined> {
  const doc = (await (await playPairDataRef(a, b)).get()).data()
  if (doc && doc.playScore !== undefined) return doc
  return (await legacyScoresRef(a, b).get()).data()
}

// F-062: what a Play tap returns (onTap) — the Play score, its breakdown and
// the Play archetype (tier1Play's), no ids. F-098: gated by plan as Spark's
// equivalents are — everyone the score; Spark+ (`full`) the breakdown, as
// Spark's breakdown; Elite (`deep`) the archetype, as Spark's archetype is
// part of Elite's Deep Fit — and the archetype in its public shape (no
// confidence), whatever the stored doc still carries.
export function playTapAnswer(scores: DocumentData | undefined, { full, deep }: { full: boolean; deep: boolean }) {
  const tier1 = deep ? publicPlayTier1(scores?.tier1Play) : null
  return {
    engineVersion: SCORE_ENGINE_VERSION,
    ...(scores && { playScore: scores.playScore }),
    breakdown: { ...(scores && full && { play: scores.playBreakdown }) },
    triggeredDealbreakers: [],
    ...(tier1 ? { playArchetype: tier1.archetype } : {}),
    locked: !full,
  }
}
