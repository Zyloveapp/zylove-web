import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { getFirestore } from 'firebase-admin/firestore'
import { playStatus } from './playAccess'
import { blockPair } from './legacy/trustSafety'
import { parseCategories, recordReport } from './reports'
import { generationOf } from './matchGeneration'

// Play connections while Play is locked (Stage 2). Someone whose Play access
// lapses can't read their Play matches or chats until it returns (the data is
// kept), but must still be able to act on them: report or block. These work
// from the match id alone — the server finds the other person, so nothing
// about them (not even who they are) reaches a client without Play access.
// Deleting the account needs nothing here: it works as usual.

interface LockedConnection {
  matchId: string
  matchedAt: number
}

const toMs = (v: unknown): number =>
  typeof v === 'number' ? v : v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0

// The caller's Play connections they can't open right now (none when they have Play access).
export const listLockedPlayConnections = onCall(
  { timeoutSeconds: 20, invoker: 'public' },
  async (request): Promise<{ connections: LockedConnection[] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    if ((await playStatus(uid)).access) return { connections: [] }
    const snap = await getFirestore().collection('matches').where('users', 'array-contains', uid).where('mode', '==', 'play').get()
    const connections = snap.docs
      .filter((d) => d.get('isBlocked') !== true && d.get('unmatchedAt') == null)
      .map((d) => ({ matchId: d.id, matchedAt: toMs(d.get('matchedAt')) || toMs(d.get('createdAt')) }))
      .sort((a, b) => b.matchedAt - a.matchedAt)
    return { connections }
  },
)

// Report or block the other person in one of the caller's Play matches.
export const actOnPlayConnection = onCall(
  { timeoutSeconds: 30, invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const data = (request.data ?? {}) as Record<string, unknown>
    const matchId = typeof data.matchId === 'string' ? data.matchId : ''
    const action = data.action
    if (!matchId || (action !== 'report' && action !== 'block')) throw new HttpsError('invalid-argument', 'matchId and action (report | block) required')
    const match = (await getFirestore().doc(`matches/${matchId}`).get()).data()
    const users: unknown = match?.users
    if (!match || match.mode !== 'play' || !Array.isArray(users) || !users.includes(uid)) {
      throw new HttpsError('not-found', 'Connection not found.')
    }
    const other = users.find((u): u is string => typeof u === 'string' && u !== uid)
    if (!other) throw new HttpsError('not-found', 'Connection not found.')
    if (action === 'block') {
      await blockPair(uid, other, matchId)
    } else {
      await recordReport({
        reporterUid: uid,
        reportedUid: other,
        matchId,
        generation: generationOf(match),
        categories: parseCategories(data),
        source: 'web-locked-play',
      })
    }
    return { success: true }
  },
)
