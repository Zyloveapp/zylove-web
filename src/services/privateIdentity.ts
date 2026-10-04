import { doc, getDoc, serverTimestamp, type WriteBatch } from 'firebase/firestore'
import { db } from './firebase'

// The private legal name: users/{uid}/private/identity, readable only by its
// owner. The rules allow creating it once and never changing it.

const identityRef = (uid: string) => doc(db, `users/${uid}/private/identity`)

export async function loadLegalName(uid: string): Promise<string | null> {
  const name: unknown = (await getDoc(identityRef(uid))).data()?.legalName
  return typeof name === 'string' && name ? name : null
}

// Adds the legal name to an onboarding batch if it's never been set — a set
// on an existing doc would be an update, which the rules refuse (and would
// fail the whole batch).
export async function addLegalName(batch: WriteBatch, uid: string, legalName: string): Promise<void> {
  const name = legalName.trim()
  if (!name || (await getDoc(identityRef(uid))).exists()) return
  batch.set(identityRef(uid), { legalName: name, legalNameSetAt: serverTimestamp() })
}
