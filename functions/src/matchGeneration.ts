import { Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'

// Match ids are the sorted uid pair, so the same two people get the same id
// every time they match (mobile's onLike even overwrites an old doc in
// place). A match's generation — when this particular match began, in ms —
// tells one match between them from the next. Records about a match
// (vibeChecks, reviews, pastConnections) are keyed by id AND generation, and
// anything in matches/{id}/messages sent before the generation belongs to an
// earlier match.
//
// matchGeneration is written at creation (likeBack, botLikeBack) and stamped
// by onMatchBehaviorUpdate on docs created without it (mobile's onLike).
// Until then it's derived the same way the web client derives it.

function millis(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return v instanceof Timestamp ? v.toMillis() : 0
}

// The match's generation, or 0 when there's nothing to go on.
export function generationOf(match: DocumentData | undefined): number {
  if (!match) return 0
  if (typeof match.matchGeneration === 'number' && match.matchGeneration > 0) return match.matchGeneration
  const known = [millis(match.matchedAt), millis(match.createdAt)].filter((ms) => ms > 0)
  return known.length ? Math.min(...known) : 0
}

export function participants(match: DocumentData | undefined): string[] {
  const users: unknown = match?.users ?? match?.participants
  return Array.isArray(users) ? users.filter((u): u is string => typeof u === 'string') : []
}

// pastConnections/{matchId}_{generation}
export const pastConnectionId = (matchId: string, generation: number) => `${matchId}_${generation}`

// Messages one generation sent: from `since` up to (not including) `until`,
// counted per sender. since 0 = from the start; until null = to now. One
// single-field range query (no composite index), reading only senderId.
export async function countMessages(
  matchId: string,
  since: number,
  until: number | null = null,
): Promise<{ total: number; bySender: Record<string, number> }> {
  let q: FirebaseFirestore.Query = getFirestore().collection(`matches/${matchId}/messages`)
  if (since > 0) q = q.where('sentAt', '>=', Timestamp.fromMillis(since))
  if (until !== null) q = q.where('sentAt', '<', Timestamp.fromMillis(until))
  const snap = await q.select('senderId').get()
  const bySender: Record<string, number> = {}
  for (const d of snap.docs) {
    const sender: unknown = d.get('senderId')
    if (typeof sender === 'string') bySender[sender] = (bySender[sender] ?? 0) + 1
  }
  return { total: snap.size, bySender }
}
