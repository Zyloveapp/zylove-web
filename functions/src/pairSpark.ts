import { FieldValue, getFirestore, type DocumentData, type WriteBatch } from 'firebase-admin/firestore'
import { publicDeepFit } from './legacy/scoring'

// Stage C: what a Spark compatibility report shows beyond the score, kept
// off the pair doc (both people can read that) in sub-docs the rules gate by
// plan:
//   pairs/{id}/modes/spark  sparkBreakdown, triggeredDealbreakers  (Spark+)
//   pairs/{id}/modes/deep   tier1Spark — Deep Fit                 (Elite)
// The pair doc keeps the score (Free sees the score only).

const db = () => getFirestore()
export const sparkDetailsRef = (pairId: string) => db().doc(`pairs/${pairId}/modes/spark`)
export const deepFitRef = (pairId: string) => db().doc(`pairs/${pairId}/modes/deep`)

export interface SparkDetails {
  sparkBreakdown: unknown
  triggeredDealbreakers: string[]
  tier1Spark: unknown
}

// Writes (into a batch) the details for a pair, and clears any old copies
// from the pair doc itself.
export function writeSparkDetails(batch: WriteBatch, pairId: string, d: { breakdown: unknown; dealbreakers: string[]; tier1?: unknown }, clearPair = true): void {
  batch.set(sparkDetailsRef(pairId), { sparkBreakdown: d.breakdown ?? {}, triggeredDealbreakers: d.dealbreakers ?? [] })
  if (d.tier1) batch.set(deepFitRef(pairId), { tier1Spark: d.tier1 })
  else batch.delete(deepFitRef(pairId))
  if (clearPair) {
    batch.set(
      db().doc(`pairs/${pairId}`),
      { sparkBreakdown: FieldValue.delete(), triggeredDealbreakers: FieldValue.delete(), tier1Spark: FieldValue.delete() },
      { merge: true },
    )
  }
}

// The details, from the sub-docs (older pair docs: from the pair itself).
// F-098: Deep Fit in its public shape (publicDeepFit) — docs stored before
// the trim keep raw floats until re-scored, so it's trimmed here, on every
// read that reaches a client (onTap, getSentSparks, getCuriousVisitors).
export async function loadSparkDetails(pairId: string, pair?: DocumentData): Promise<SparkDetails> {
  const [s, d] = await db().getAll(sparkDetailsRef(pairId), deepFitRef(pairId))
  return {
    sparkBreakdown: s.get('sparkBreakdown') ?? pair?.sparkBreakdown ?? {},
    triggeredDealbreakers: (s.get('triggeredDealbreakers') ?? pair?.triggeredDealbreakers ?? []) as string[],
    tier1Spark: publicDeepFit(d.get('tier1Spark') ?? pair?.tier1Spark ?? null),
  }
}
