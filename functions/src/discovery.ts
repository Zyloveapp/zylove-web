// Explore pool diversity: every user doc carries a random sortKey (0–1, set
// once, never changed). The web client starts its candidate query at a random
// point in sortKey order, so different users — and different loads — see
// different slices of the pool instead of the same first 50 docs.

import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { getFirestore } from 'firebase-admin/firestore'

// Any user doc without a sortKey gets one the next time it's written. Covers
// mobile sign-ups (which never call initUserDefaults), bots, and accounts that
// existed before sortKey did. The added write doesn't loop: the doc then has one.
export const ensureSortKey = onDocumentWritten('users/{uid}', async (event) => {
  const after = event.data?.after
  if (!after?.exists || typeof after.data()?.sortKey === 'number') return
  await getFirestore().doc(`users/${event.params.uid}`).set({ sortKey: Math.random() }, { merge: true })
})
