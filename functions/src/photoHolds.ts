import { createHash } from 'node:crypto'
import { getFirestore, type DocumentData, type DocumentReference } from 'firebase-admin/firestore'

// F-071: why a photo was held by the scam blocklist — the banned account's
// uid, name, ban time, scam box and report counts — is server-only, in
// photoHolds/{id}. It used to sit on the held photo's pendingPhotoURLs entry,
// which its owner can read (users/{uid}/private/account): often the very
// person whose photo the scammer stole. The owner's entry keeps only
// { blocklist: true }; Photo review joins the two by the id below.

export const photoHoldId = (uid: string, url: string): string => createHash('sha256').update(`${uid}\n${url}`).digest('hex').slice(0, 40)
export const photoHoldRef = (uid: string, url: string): DocumentReference => getFirestore().doc(`photoHolds/${photoHoldId(uid, url)}`)

// A hold's reason as the owner may see it, and the context kept apart.
export function splitHoldReason(reason: DocumentData): { owner: DocumentData; context: DocumentData | null } {
  if (reason.blocklist !== true) return { owner: reason, context: null }
  const { match, more, distance, ...rest } = reason
  return { owner: { ...rest, blocklist: true }, context: { match: match ?? null, more: more ?? 0, distance: distance ?? null } }
}

// For Photo review: the entry's reason with its kept context put back.
export async function withHoldContext(uid: string, url: string, reason: unknown): Promise<unknown> {
  if (!reason || typeof reason !== 'object' || (reason as DocumentData).blocklist !== true || (reason as DocumentData).match) return reason
  const ctx = (await photoHoldRef(uid, url).get()).data()
  return ctx ? { ...(reason as DocumentData), match: ctx.match, more: ctx.more, distance: ctx.distance } : reason
}

// Every hold of an account (deleted with it).
export async function removePhotoHolds(uid: string): Promise<void> {
  const snap = await getFirestore().collection('photoHolds').where('uid', '==', uid).get()
  await Promise.all(snap.docs.map((d) => d.ref.delete()))
}
