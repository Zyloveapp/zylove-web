import { getFirestore, FieldValue, type DocumentData, type DocumentReference, type WriteBatch } from 'firebase-admin/firestore'
import { playStatus } from './playAccess'

// Play scores for a pair live apart from the pair doc (Stage 2): pairs/{id}
// keeps the Spark score, likes and reveals; pairs/{id}/modes/play holds
// playScore, playBreakdown and tier1Play, readable only by participants who
// have Play access (firestore.rules). They're computed only when both people
// have Play access — a Spark-only user's tap never produces Play data.

export const PLAY_PAIR_FIELDS = ['playScore', 'playBreakdown', 'tier1Play'] as const

export const playPairRef = (pairId: string): DocumentReference => getFirestore().doc(`pairs/${pairId}/modes/play`)

export async function bothHavePlay(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([playStatus(a), playStatus(b)])
  return sa.access && sb.access
}

// The Play fields of a scoring result, ready to store (tier1Play only when set).
export function playFields(score: number, breakdown: unknown, tier1: unknown): DocumentData {
  return { playScore: score, playBreakdown: breakdown, ...(tier1 ? { tier1Play: tier1 } : {}) }
}

// Stores the Play scores (or, with null, removes them) — in a batch if given.
export function setPlayScores(pairId: string, fields: DocumentData | null, batch?: WriteBatch): Promise<unknown> | void {
  const ref = playPairRef(pairId)
  if (batch) {
    if (fields) batch.set(ref, { ...fields, updatedAt: FieldValue.serverTimestamp() })
    else batch.delete(ref)
    return
  }
  return fields ? ref.set({ ...fields, updatedAt: FieldValue.serverTimestamp() }) : ref.delete()
}

// The pair's Play scores: the subdoc, else (pairs not migrated yet) the old
// copies on the pair doc.
export async function loadPlayScores(pairId: string, pair?: DocumentData): Promise<DocumentData | undefined> {
  const sub = (await playPairRef(pairId).get()).data()
  if (sub) return sub
  const p = pair ?? (await getFirestore().doc(`pairs/${pairId}`).get()).data()
  return p && p.playScore !== undefined ? { playScore: p.playScore, playBreakdown: p.playBreakdown, tier1Play: p.tier1Play } : undefined
}
