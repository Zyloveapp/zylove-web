// functions/src/claimWomenElite.ts
//
// Background tier elevation for women at onboarding finalize.
// Reads the caller's genderIdentity from their user doc; if a woman
// identity, writes subscriptionTier: 'elite'. Idempotent — already-elite
// users get a no-op success.
//
// Why server-side: Firestore rules block all client writes to
// subscriptionTier (firestore.rules:45-60). Tier elevation must come
// from the admin SDK.
//
// Caller invokes fire-and-forget at onboarding finalize; failures are
// non-fatal (women still get runtime bypasses via isWomanIdentity at
// every gate site).

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { LEGACY_RUNTIME } from './legacyOptions'
import { internalRef, loadInternal } from '../userData'

const db = admin.firestore()

// Mirrors src/types/subscription.ts isWomanIdentity, but matches the
// underscore form actually stored in genderIdentity (the client helper
// has a divergence — see PR notes). Exported so other server modules
// (founderCodes, etc.) can reuse without redefining.
export function isWomanIdentity(g: string | undefined): boolean {
  if (!g) return false
  const v = g.toLowerCase().trim()
  return v === 'woman' || v === 'trans_woman'
}

export const claimWomenElite = onCall(LEGACY_RUNTIME, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.')
  }

  const uid = request.auth.uid
  const userRef = db.collection('users').doc(uid)
  const snap = await userRef.get()

  if (!snap.exists) {
    throw new HttpsError('failed-precondition', 'User doc not found.')
  }

  const data = snap.data() ?? {}
  const gender = data.genderIdentity

  if (!isWomanIdentity(gender)) {
    return { success: false, error: 'not_eligible' }
  }

  if ((await loadInternal(uid, data)).subscriptionTier === 'elite') {
    return { success: true, alreadyElite: true }
  }

  await internalRef(uid).set({
    subscriptionTier: 'elite',
    subscriptionSource: 'women_auto',
    subscriptionGrantedAt: Date.now(),
  }, { merge: true })

  return { success: true, alreadyElite: false }
})
