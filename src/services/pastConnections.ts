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

export async function fetchPastConnections(): Promise<PastConnection[]> {
  const res = await httpsCallable<void, { connections: PastConnection[] }>(functions, 'getPastConnections')()
  return res.data.connections
}
