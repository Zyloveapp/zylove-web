import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { ageFrom } from './location'
import { identityRef, internalRef, userRef } from './userData'
import { suspendAccount } from './reports'
import { queueAdminAlert } from './adminAlerts'
import { isBotUid } from './playAccess'

// F-066: identity and age, decided server-side.
//
// - The identity lock (users/{uid}.identityLockedAt, server-only) is set on
//   the first write that carries a gender identity — it used to wait for the
//   client to call initUserDefaults, and a client that didn't stayed
//   unlocked (gender, matchableAs and age editable for good). Identity-based
//   Elite (entitlements.ts) needs the lock.
// - 18+: the rules refuse an under-18 birthday or age; anyone who got past
//   them (older accounts, a missing birthday with an under-18 age) is
//   suspended pending review here, and the admins are alerted.

export const MIN_AGE = 18

// The age a profile counts as: the private birthday's, else the public age.
export function effectiveAge(identity: DocumentData | undefined, root: DocumentData | undefined): number | null {
  const fromBirthday = ageFrom(identity?.birthday)
  if (fromBirthday !== null) return fromBirthday
  return typeof root?.age === 'number' ? root.age : null
}

export const isUnderage = (age: number | null): boolean => age !== null && age < MIN_AGE

async function suspendUnderage(uid: string): Promise<void> {
  const internal = (await internalRef(uid).get()).data()
  if (internal?.isSuspended === true && internal.suspendReason === 'underage') return
  await suspendAccount(uid, null, 'system', 'trust')
  await internalRef(uid).set({ suspendReason: 'underage' }, { merge: true })
  // On the Trust page, where the alert links (the suspension's reason stays
  // on userInternal if a rescore later rewrites the flag's reasons).
  await getFirestore().doc(`trustFlags/${uid}`).set(
    {
      uid,
      status: 'open',
      score: 100,
      reasons: [{ key: 'underage', points: 100, text: 'Under 18 by their birthday — suspended pending review' }],
      openedAt: Timestamp.now(),
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt: null,
    },
    { merge: true },
  )
  await queueAdminAlert('trustFlag', { subjectUid: uid, reasons: ['underage'] })
  logger.warn('identityGuard: under 18 — suspended pending review')
}

async function checkAge(uid: string, root?: DocumentData): Promise<void> {
  const r = root ?? (await userRef(uid).get()).data()
  if (!r || r.isDeleted === true) return
  const identity = (await identityRef(uid).get()).data()
  if (isUnderage(effectiveAge(identity, r))) await suspendUnderage(uid)
}

export const identityGuardOnUser = onDocumentWritten({ document: 'users/{uid}', memory: '256MiB' }, async (event) => {
  const uid = event.params.uid
  if (isBotUid(uid)) return
  const after = event.data?.after.data()
  if (!after || after.isDeleted === true) return
  const before = event.data?.before.data()
  if (after.genderIdentity != null && after.identityLockedAt == null) {
    await getFirestore()
      .runTransaction(async (tx) => {
        const now = (await tx.get(userRef(uid))).data()
        if (!now || now.identityLockedAt != null || now.genderIdentity == null) return
        tx.update(userRef(uid), { identityLockedAt: FieldValue.serverTimestamp() })
      })
  }
  const touched = ['age', 'genderIdentity', 'onboardingComplete'].some((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after[k] ?? null))
  if (touched) await checkAge(uid, after)
})

export const identityGuardOnIdentity = onDocumentWritten({ document: 'users/{uid}/private/identity', memory: '256MiB' }, async (event) => {
  const uid = event.params.uid
  if (isBotUid(uid)) return
  const after = event.data?.after.data()
  if (!after || event.data?.before.data()?.birthday === after.birthday) return
  await checkAge(uid)
})
