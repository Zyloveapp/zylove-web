import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

// Play photos never sit on the public root doc (Stage 2, F-004). Play-only
// accounts used to have their Play photos mirrored onto users/{uid}.photoURLs
// so Explore would show them; Play Explore now reads the Play profile, so
// this does the opposite: whenever a Play profile changes, any of the
// owner's Play photos (photos/{uid}/play/… — every user photo is a path since
// Stage 1b) on the root doc are removed. Spark photos are never touched.
// Kept under the old name so the deploy updates it in place.
export const mirrorPlayOnlyPhotos = onDocumentWritten('users/{uid}/playProfile/data', async (event) => {
  const uid = event.params.uid
  // Bots share their (public, Spark-path) photos between both profiles.
  if (uid.startsWith('zbot-')) return
  const userRef = getFirestore().collection('users').doc(uid)
  const root = strings((await userRef.get()).data()?.photoURLs)
  if (root.length === 0) return
  const remove = root.filter((u) => u.startsWith(`photos/${uid}/play/`))
  if (remove.length === 0) return
  await userRef.update({ photoURLs: FieldValue.arrayRemove(...remove) })
  logger.info('mirrorPlayOnlyPhotos: Play photos removed from the root doc', { uid, count: remove.length })
})
