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
