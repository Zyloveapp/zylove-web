import { FieldValue, getFirestore, type DocumentData, type WriteBatch } from 'firebase-admin/firestore'
import { publicDeepFit, sparkBreakdownFor, type SparkView } from './legacy/scoring'

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
export function writeSparkDetails(
  batch: WriteBatch,
  pairId: string,
  d: { breakdown: unknown; dealbreakers: string[]; tier1?: unknown; views?: Record<string, SparkView> },
  clearPair = true,
): void {
  // F-119: each person's own dealbreaker bar and Deep Fit.
  const views = d.views ? Object.entries(d.views) : []
  batch.set(sparkDetailsRef(pairId), {
    sparkBreakdown: d.breakdown ?? {},
    triggeredDealbreakers: d.dealbreakers ?? [],
    ...(views.length && { dealbreakersFor: Object.fromEntries(views.map(([u, v]) => [u, v.dealbreakers])) }),
  })
  const tier1For = Object.fromEntries(views.filter(([, v]) => v.tier1).map(([u, v]) => [u, v.tier1]))
  if (d.tier1 || Object.keys(tier1For).length) {
    batch.set(deepFitRef(pairId), { tier1Spark: d.tier1 ?? null, ...(Object.keys(tier1For).length && { tier1For }) })
  } else batch.delete(deepFitRef(pairId))
  if (clearPair) {
    batch.set(
      db().doc(`pairs/${pairId}`),
      { sparkBreakdown: FieldValue.delete(), triggeredDealbreakers: FieldValue.delete(), tier1Spark: FieldValue.delete() },
      { merge: true },
    )
  }
}

// The details as `viewerUid` (one of the pair) may see them, from the
// sub-docs (older pair docs: from the pair itself). F-098: Deep Fit in its
// public shape (publicDeepFit) and the breakdown's physical bar as the
// viewer's own direction (sparkBreakdownFor) — docs stored before the trim
// keep raw floats and the two-way mean until re-scored, so it's done here,
// on every read that reaches a client (onTap, getSentSparks,
// getCuriousVisitors).
export async function loadSparkDetails(pairId: string, viewerUid: string, pair?: DocumentData): Promise<SparkDetails> {
  const [s, d] = await db().getAll(sparkDetailsRef(pairId), deepFitRef(pairId))
  const breakdown = sparkBreakdownFor(s.get('sparkBreakdown') ?? pair?.sparkBreakdown ?? {}, viewerUid)
  // F-119: the viewer's own dealbreaker bar and Deep Fit, when scored per viewer.
  const ownBar: unknown = (s.get('dealbreakersFor') as Record<string, unknown> | undefined)?.[viewerUid]
  if (typeof ownBar === 'number') breakdown.dealbreakers = ownBar
  const tier1For = d.get('tier1For') as Record<string, unknown> | undefined
  const scored = tier1For ? (tier1For[viewerUid] ?? null) : (d.get('tier1Spark') ?? pair?.tier1Spark ?? null)
  return {
    sparkBreakdown: breakdown,
    triggeredDealbreakers: (s.get('triggeredDealbreakers') ?? pair?.triggeredDealbreakers ?? []) as string[],
    tier1Spark: publicDeepFit(scored),
  }
}
