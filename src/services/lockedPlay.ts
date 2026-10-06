import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// Play connections while Play is locked (Stage 2): without Play access the
// Play matches and chats are hidden (kept, back when access is), but the
// user can still report or block them. By match id only — the server finds
// the other person (functions/src/lockedPlay.ts).

export interface LockedConnection {
  matchId: string
  matchedAt: number
}

export async function listLockedPlayConnections(): Promise<LockedConnection[]> {
  const { data } = await httpsCallable<object, { connections: LockedConnection[] }>(functions, 'listLockedPlayConnections')({})
  return data.connections
}

export async function reportLockedPlayConnection(matchId: string, categories: string[]): Promise<void> {
  await httpsCallable(functions, 'actOnPlayConnection')({ matchId, action: 'report', categories })
}

export async function blockLockedPlayConnection(matchId: string): Promise<void> {
  await httpsCallable(functions, 'actOnPlayConnection')({ matchId, action: 'block' })
}
