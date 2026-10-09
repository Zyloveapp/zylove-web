import { createHash } from 'node:crypto'
import { getFirestore, type DocumentData, type DocumentReference } from 'firebase-admin/firestore'

// F-071: why a photo was held by the scam blocklist — the banned account's
// uid, name, ban time, scam box and report counts — is server-only, in
// photoHolds/{id}. It used to sit on the held photo's pendingPhotoURLs entry,
// which its owner can read (users/{uid}/private/account): often the very
// person whose photo the scammer stole. The owner's entry keeps only
// { blocklist: true }; Photo review joins the two by the id below.
//
// F-081: photos held for their content (Sightengine scores over the limits)
// get a photoHolds doc too — { uid, url, mode, kind: 'content', reason,
// heldAt } — so a hold stays in Photo review even if its pendingPhotoURLs
// entry goes. Blocklist holds are kind 'blocklist' (older ones have no kind).
// Holds for other reasons (no face in a first photo, a moderation error)
// aren't kept: their owner may drop them with the profile (deleteModePhotos).

export const photoHoldId = (uid: string, url: string): string => createHash('sha256').update(`${uid}\n${url}`).digest('hex').slice(0, 40)
export const photoHoldRef = (uid: string, url: string): DocumentReference => getFirestore().doc(`photoHolds/${photoHoldId(uid, url)}`)

// Whether a pendingPhotoURLs entry's reason is one kept for review whatever
// its owner does: a blocklist match or a content flag.
export function isKeptHold(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false
  const r = reason as DocumentData
  return r.blocklist === true || (Array.isArray(r.exceeded) && r.exceeded.length > 0)
}

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

// A hold's reason from its photoHolds doc alone (its entry gone).
export function holdReason(hold: DocumentData): unknown {
  if (hold.kind === 'content') return hold.reason ?? null
  return { blocklist: true, match: hold.match ?? null, more: hold.more ?? 0, distance: hold.distance ?? null }
}

// The Storage paths of an account's kept holds.
export async function heldUrls(uid: string): Promise<Set<string>> {
  const snap = await getFirestore().collection('photoHolds').where('uid', '==', uid).get()
  return new Set(snap.docs.map((d) => d.get('url')).filter((u): u is string => typeof u === 'string'))
}

// Every hold of an account (deleted with it).
export async function removePhotoHolds(uid: string): Promise<void> {
  const snap = await getFirestore().collection('photoHolds').where('uid', '==', uid).get()
  await Promise.all(snap.docs.map((d) => d.ref.delete()))
}
