import { getFirestore } from 'firebase-admin/firestore'

// T&S Phase 1: the admin directory's name index — userInternal.searchName,
// the lowercase display name (server-only). Kept current on app load
// (initUserDefaults), on a name change and nightly (computeTrustScores).
export async function updateSearchName(uid: string, displayName: unknown): Promise<void> {
  const name = typeof displayName === 'string' ? displayName.trim().toLowerCase() : ''
  if (name) await getFirestore().doc(`userInternal/${uid}`).set({ searchName: name }, { merge: true })
}
