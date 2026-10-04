import { collection, doc, getDocs, serverTimestamp, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'

// Block goes through mobile's blockUser callable (already deployed): it marks
// the match blocked and writes users/{uid}/blockedUsers/{other} for both
// people, which only each owner can read — so who blocked whom stays private.
export async function blockMatch(matchId: string, targetUid: string): Promise<void> {
  await httpsCallable<{ targetUid: string; matchId: string }, { success: true }>(functions, 'blockUser')({ targetUid, matchId })
}

// Soft unmatch: the match stays (so it can still be reviewed and reported)
// but counts as ended everywhere.
export async function unmatch(matchId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, 'matches', matchId), { unmatchedAt: serverTimestamp(), unmatchedBy: uid })
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

// Serious reports also go on the reported person's phone record (hashed,
// server-side) so a ban survives them making a new account.
const SERIOUS_CATEGORIES = ['felt_unsafe', 'aggressive', 'pushed_boundaries', 'inappropriate']
const URGENT_CATEGORIES = ['felt_unsafe', 'aggressive']

export function isSeriousReport(categories: string[]): boolean {
  return categories.some((c) => SERIOUS_CATEGORIES.includes(c))
}

export async function reportAndBan(reportedUid: string, matchId: string, categories: string[]): Promise<void> {
  const severity = categories.some((c) => URGENT_CATEGORIES.includes(c)) ? 'urgent' : 'standard'
  await httpsCallable<
    { reportedUid: string; matchId: string; categories: string[]; severity: 'standard' | 'urgent' },
    { success: true }
  >(functions, 'reportAndBan')({ reportedUid, matchId, categories, severity })
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
