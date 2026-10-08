import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// Block goes through mobile's blockUser callable (already deployed): it marks
// the match blocked and writes users/{uid}/blockedUsers/{other} for both
// people — server-only (F-062), so who blocked whom stays private. In Play,
// targetUid is the other person's Play ID; the server maps it.
export async function blockMatch(matchId: string, targetUid: string): Promise<void> {
  await httpsCallable<{ targetUid: string; matchId: string }, { success: true }>(functions, 'blockUser')({ targetUid, matchId })
}

// Unmatch ends the connection for good, as mobile's does: the
// unmatchConnection callable records it (so it can still be reviewed and
// reported) and deletes the match, and the server then deletes its messages
// and photos.
export async function unmatch(matchId: string): Promise<void> {
  await httpsCallable<{ matchId: string }, { success: true }>(functions, 'unmatchConnection')({ matchId })
}

// Serious categories: a review flagging one of these also files a report.
const SERIOUS_CATEGORIES = ['felt_unsafe', 'aggressive', 'pushed_boundaries', 'inappropriate']

export function isSeriousReport(categories: string[]): boolean {
  return categories.some((c) => SERIOUS_CATEGORIES.includes(c))
}

// Files (or adds to) a confidential report — separate from reviews, so an
// earlier review or an empty chat never blocks it. Negative categories only;
// the server decides priority. Reports only queue for the team; nothing
// happens to the reported account unless an admin acts.
export async function submitReport(matchId: string, generation: number, reportedUid: string, categories: string[]): Promise<void> {
  await httpsCallable<
    { matchId: string; generation?: number; reportedUid: string; categories: string[] },
    { success: true }
  >(functions, 'submitReport')({ matchId, ...(generation > 0 ? { generation } : {}), reportedUid, categories })
}

export interface BlockedUser {
  uid: string
  name: string
  blockedAt: number
}

// People the caller blocked (never people who blocked them), from that
// mode's matches only. F-062: Play's list names them by Play ID (in uid here).
export async function fetchBlockedUsers(mode: 'spark' | 'play'): Promise<BlockedUser[]> {
  const res = await httpsCallable<{ mode: string }, { blocked: (Omit<BlockedUser, 'uid'> & { uid?: string; playId?: string })[] }>(
    functions,
    'getBlockedUsers',
  )({ mode })
  return res.data.blocked.map(({ playId, uid, ...b }) => ({ ...b, uid: playId ?? uid ?? '' }))
}

export async function unblockMember(targetUid: string): Promise<void> {
  await httpsCallable<{ targetUid: string }, { success: true }>(functions, 'unblockMember')({ targetUid })
}
