import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { playIdOf } from './playIds'

// Stage A: clients can't delete profile photos any more (storage.rules) — a
// deleted name could be uploaded again with new bytes while Firestore still
// lists it as published, and everyone would be shown the unmoderated
// replacement. The server deletes a photo instead, once it's on none of the
// lists: published Spark (users/{uid}.photoURLs), published Play
// (playProfile/data.photoURLs) or in review (private/account.pendingPhotoURLs).
// Soft-deleted accounts keep their photos (a restore brings them back).

const refsOf = (d: DocumentData | undefined, field: 'photoURLs' | 'pendingPhotoURLs'): string[] => {
  const raw: unknown = d?.[field]
  if (!Array.isArray(raw)) return []
  return raw
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { url?: unknown }).url === 'string' ? (x as { url: string }).url : null))
    .filter((x): x is string => !!x)
}

async function deleteUnlisted(uid: string, removed: string[]): Promise<void> {
  // F-062: Play photos are under the account's Play ID.
  const playId = await playIdOf(uid)
  const own = removed.filter(
    (r) => r.startsWith(`photos/${uid}/spark/`) || r.startsWith(`photos/${uid}/play/`) || (!!playId && r.startsWith(`playPhotos/${playId}/`)),
  )
  if (!own.length) return
  const db = getFirestore()
  // Current state, not the event's: an approval moves pending → published
  // in one transaction, so a photo mid-move is still listed somewhere.
  const [root, play, account] = await db.getAll(
    db.doc(`users/${uid}`),
    db.doc(`users/${uid}/playProfile/data`),
    db.doc(`users/${uid}/private/account`),
  )
  if (!root.exists || root.get('isDeleted') === true) return
  const listed = new Set([
    ...refsOf(root.data(), 'photoURLs'),
    ...refsOf(root.data(), 'pendingPhotoURLs'),
    ...refsOf(play.data(), 'photoURLs'),
    ...refsOf(play.data(), 'pendingPhotoURLs'),
    ...refsOf(account.data(), 'pendingPhotoURLs'),
  ])
  const bucket = getStorage().bucket()
  for (const ref of own.filter((r) => !listed.has(r))) {
    await bucket.file(ref).delete({ ignoreNotFound: true }).catch((err: unknown) =>
      logger.warn('photo cleanup: delete failed', { message: err instanceof Error ? err.message : String(err) }),
    )
  }
}

function removedRefs(before: DocumentData | undefined, after: DocumentData | undefined, fields: ('photoURLs' | 'pendingPhotoURLs')[]): string[] {
  const now = new Set(fields.flatMap((f) => refsOf(after, f)))
  return [...new Set(fields.flatMap((f) => refsOf(before, f)))].filter((r) => !now.has(r))
}

export const photoCleanupOnUser = onDocumentUpdated({ document: 'users/{uid}' }, async (e) => {
  const removed = removedRefs(e.data?.before.data(), e.data?.after.data(), ['photoURLs', 'pendingPhotoURLs'])
  if (removed.length) await deleteUnlisted(e.params.uid, removed)
})

export const photoCleanupOnUserDoc = onDocumentUpdated({ document: 'users/{uid}/{sub}/{doc}' }, async (e) => {
  const { uid, sub, doc } = e.params
  const fields: ('photoURLs' | 'pendingPhotoURLs')[] | null =
    sub === 'playProfile' && doc === 'data' ? ['photoURLs', 'pendingPhotoURLs'] : sub === 'private' && doc === 'account' ? ['pendingPhotoURLs'] : null
  if (!fields) return
  const removed = removedRefs(e.data?.before.data(), e.data?.after.data(), fields)
  if (removed.length) await deleteUnlisted(uid, removed)
})
