import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { getFirestore } from 'firebase-admin/firestore'

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

// Play-only accounts (web onboarding's Play path) have no Spark profile, so
// their photos live only on playProfile/data — onPhotoUpload (mobile codebase)
// publishes approved Play photos there. Explore filters on the root doc's
// photoURLs, so while the account stays Play-only the approved list is mirrored
// onto users/{uid}. Once a Spark profile exists, root photoURLs are the Spark
// photos and this leaves them alone.
export const mirrorPlayOnlyPhotos = onDocumentWritten('users/{uid}/playProfile/data', async (event) => {
  const after = event.data?.after.data()
  if (!after) return
  const urls = strings(after.photoURLs)
  if (sameList(urls, strings(event.data?.before.data()?.photoURLs))) return

  const userRef = getFirestore().collection('users').doc(event.params.uid)
  const [user, spark] = await Promise.all([userRef.get(), userRef.collection('sparkProfile').doc('data').get()])
  const data = user.data()
  if (!data || data.onboardingPath !== 'play' || spark.exists) return
  if (sameList(urls, strings(data.photoURLs))) return

  await userRef.update({ photoURLs: urls })
  logger.info('mirrorPlayOnlyPhotos: root photoURLs updated', {
    uid: event.params.uid,
    count: urls.length,
  })
})
