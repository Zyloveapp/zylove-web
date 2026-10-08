import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// Everyone you matched with in the last 90 days, including ended matches —
// names and dates only. Served by the getPastConnections callable because
// ended matches live in a server-only collection.
export interface PastConnection {
  matchId: string
  // Which match between these two; 0 for records from before generations.
  generation: number
  otherUid: string
  name: string
  matchedAt: number
  ended: boolean
}

// Only the given mode's connections (old matches without a mode are Spark).
// F-062: a Play connection names the other person by Play ID (otherPlayId,
// put in otherUid here — the id the app knows them by in Play).
export async function fetchPastConnections(mode: 'spark' | 'play'): Promise<PastConnection[]> {
  const res = await httpsCallable<{ mode: string }, { connections: (Omit<PastConnection, 'otherUid'> & { otherUid?: string; otherPlayId?: string })[] }>(
    functions,
    'getPastConnections',
  )({ mode })
  return res.data.connections.map(({ otherPlayId, otherUid, ...c }) => ({ ...c, otherUid: otherPlayId ?? otherUid ?? '' }))
}
