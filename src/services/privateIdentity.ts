import { doc, getDoc, serverTimestamp, type WriteBatch } from 'firebase/firestore'
import { db } from './firebase'

// Private identity: users/{uid}/private/identity, readable only by its owner.
//   legalName   set once, never changed
//   birthday    ISO date; changeable only until identity is locked
//               (users/{uid}.identityLockedAt). The public doc carries only
//               the age, which the server keeps current from this.

const identityRef = (uid: string) => doc(db, `users/${uid}/private/identity`)

export interface PrivateIdentity {
  legalName: string | null
  birthday: string | null
}

// Older accounts still have the birthday on the public doc (rootBirthday);
// it counts until migrated.
export async function loadIdentity(uid: string, rootBirthday?: unknown): Promise<PrivateIdentity> {
  const d = (await getDoc(identityRef(uid)).catch(() => null))?.data()
  const name: unknown = d?.legalName
  const birthday: unknown = d?.birthday ?? rootBirthday
  return {
    legalName: typeof name === 'string' && name ? name : null,
    birthday: typeof birthday === 'string' && birthday ? birthday : null,
  }
}

export async function loadLegalName(uid: string): Promise<string | null> {
  return (await loadIdentity(uid)).legalName
}

// Adds the identity to an onboarding batch: the legal name if it's never been
// set, and the birthday when given (pass null once identity is locked — the
// rules refuse a change then, which would fail the whole batch).
export async function addIdentity(batch: WriteBatch, uid: string, legalName: string, birthday: string | null): Promise<void> {
  const name = legalName.trim()
  const snap = await getDoc(identityRef(uid))
  const current = snap.data()
  const patch: Record<string, unknown> = {}
  if (name && !current?.legalName) Object.assign(patch, { legalName: name, legalNameSetAt: serverTimestamp() })
  if (birthday && current?.birthday !== birthday) patch.birthday = birthday
  if (Object.keys(patch).length === 0) return
  if (snap.exists()) batch.update(identityRef(uid), patch)
  else batch.set(identityRef(uid), patch)
}
