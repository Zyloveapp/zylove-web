import { collection, getDocs } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'

// Block goes through mobile's blockUser callable (already deployed): it marks
// the match blocked and writes users/{uid}/blockedUsers/{other} for both
// people, which only each owner can read — so who blocked whom stays private.
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

// Everyone blocked in either direction. Unreadable → nobody, rather than
// breaking Explore.
export async function loadBlockedUids(uid: string): Promise<Set<string>> {
  try {
    const snap = await getDocs(collection(db, `users/${uid}/blockedUsers`))
    return new Set(snap.docs.map((d) => d.id))
  } catch {
    return new Set()
  }
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
// mode's matches only.
export async function fetchBlockedUsers(mode: 'spark' | 'play'): Promise<BlockedUser[]> {
  const res = await httpsCallable<{ mode: string }, { blocked: BlockedUser[] }>(functions, 'getBlockedUsers')({ mode })
  return res.data.blocked
}

export async function unblockMember(targetUid: string): Promise<void> {
  await httpsCallable<{ targetUid: string }, { success: true }>(functions, 'unblockMember')({ targetUid })
}
