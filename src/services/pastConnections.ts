import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// Everyone you matched with in the last 90 days, including ended matches —
// names and dates only. Served by the getPastConnections callable because
// ended matches live in a server-only collection.
export interface PastConnection {
  matchId: string
  otherUid: string
  name: string
  matchedAt: number
  ended: boolean
}

// Only the given mode's connections (old matches without a mode are Spark).
export async function fetchPastConnections(mode: 'spark' | 'play'): Promise<PastConnection[]> {
  const res = await httpsCallable<{ mode: string }, { connections: PastConnection[] }>(
    functions,
    'getPastConnections',
  )({ mode })
  return res.data.connections
}
