import { createHash, randomBytes } from 'node:crypto'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { audit, requireAdminAudited } from './audit'
import { pauseEvidenceFor, resumeEvidenceFor } from './evidence'
import { refreshEntry } from './explore'
import { liftSuspension } from './reports'
import { OUTCOME_RETENTION_MS } from './lockerCore'
import { queueAdminAlert } from './adminAlerts'

// T&S Phase 4 — one appeal per suspension.
//
// A suspended account can't sign in (onBeforeSignIn refuses it — the Auth
// account itself stays enabled, so the refusal happens only after the person
// has proven they own the phone). The refusal carries a short-lived,
// single-use appeal token; the sign-in screen uses it to offer an appeal with
// a short note. Admins decide it (upheld / overturned), with a reason, logged.
//   appeals/{uid}_{suspendedAtMs}  { uid, suspendedAt, note, status, submittedAt,
//                                    decidedBy?, decidedAt?, decisionReason? }
//   appealTokens/{sha256(token)}   { uid, key, expiresAt, used }

export const APPEAL_NOTE_MAX = 1000
const TOKEN_TTL_MS = 30 * 60 * 1000
const db = () => getFirestore()
const sha = (t: string) => createHash('sha256').update(t).digest('hex')
const ms = (v: unknown): number => (v instanceof Timestamp ? v.toMillis() : typeof v === 'number' ? v : 0)

export type AppealState = 'none' | 'pending' | 'upheld' | 'overturned'

// The refusal message for a suspended account, or null to let it sign in
// (not suspended; suspended only for a pending deletion, which they must be
// able to sign in to cancel; or the suspension has run out).
export async function suspensionRefusal(uid: string): Promise<string | null> {
  const n = (await db().doc(`userInternal/${uid}`).get()).data()
  if (n?.isSuspended !== true || n.suspendedForDeletion === true) return null
  const until = ms(n.suspendedUntil)
  if (until > 0 && until <= Date.now()) return null
  const key = String(ms(n.suspendedAt) || 0)
  const appeal = (await db().doc(`appeals/${uid}_${key}`).get()).data()
  const state: AppealState = appeal ? (appeal.status as AppealState) : 'none'
  let token = '-'
  if (state === 'none') {
    token = randomBytes(24).toString('base64url')
    await db().doc(`appealTokens/${sha(token)}`).set({ uid, key, used: false, expiresAt: Timestamp.fromMillis(Date.now() + TOKEN_TTL_MS) })
  }
  // Parsed by the app's sign-in screen (src/services/appeals.ts).
  return `ZYLOVE_SUSPENDED:${token}:${state}:${n.suspendedPendingReview === true ? 'review' : 'timed'}:${until}`
}

export const submitAppeal = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  const data = (request.data ?? {}) as Record<string, unknown>
  const token = typeof data.token === 'string' ? data.token : ''
  const note = typeof data.note === 'string' ? data.note.trim() : ''
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpsError('invalid-argument', 'This appeal link has expired — sign in again to appeal.')
  if (note.length < 10) throw new HttpsError('invalid-argument', 'Tell us a little about why (at least 10 characters).')
  if (note.length > APPEAL_NOTE_MAX) throw new HttpsError('invalid-argument', `Keep it under ${APPEAL_NOTE_MAX} characters.`)
  const tokenRef = db().doc(`appealTokens/${sha(token)}`)
  const uid = await db().runTransaction(async (tx) => {
    const t = (await tx.get(tokenRef)).data()
    if (!t || t.used === true || ms(t.expiresAt) <= Date.now()) throw new HttpsError('failed-precondition', 'This appeal link has expired — sign in again to appeal.')
    const ref = db().doc(`appeals/${t.uid}_${t.key}`)
    if ((await tx.get(ref)).exists) throw new HttpsError('already-exists', "You've already appealed this suspension.")
    tx.create(ref, { uid: t.uid, suspendedAt: Number(t.key), note, status: 'pending', submittedAt: FieldValue.serverTimestamp() })
    tx.update(tokenRef, { used: true })
    return t.uid as string
  })
  await pauseEvidenceFor(uid)
  await audit({ actor: uid, action: 'appeal.submit', target: uid, detail: { length: note.length } })
  await queueAdminAlert('appeal', { subjectUid: uid })
  return { ok: true }
})

export const adminListAppeals = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  const status = (request.data as Record<string, unknown> | null)?.status === 'decided' ? 'decided' : 'pending'
  await requireAdminAudited(request.auth, { action: 'appeal.list', detail: { status } })
  const snap = await db().collection('appeals').where('status', status === 'pending' ? '==' : 'in', status === 'pending' ? 'pending' : ['upheld', 'overturned']).limit(100).get()
  const uids = [...new Set(snap.docs.map((d) => String(d.get('uid'))))]
  const [users, internals] = uids.length
    ? await Promise.all([db().getAll(...uids.map((u) => db().doc(`users/${u}`))), db().getAll(...uids.map((u) => db().doc(`userInternal/${u}`)))])
    : [[], []]
  const name = new Map(users.map((u) => [u.id, String(u.data()?.displayName ?? 'Unknown')]))
  const internal = new Map(internals.map((u) => [u.id, u.data() ?? {}]))
  return {
    appeals: snap.docs.map((d) => {
      const a = d.data() as DocumentData
      const n = internal.get(a.uid) as DocumentData
      return {
        id: d.id,
        uid: a.uid,
        name: name.get(a.uid) ?? 'Unknown',
        note: a.note,
        status: a.status,
        submittedAt: ms(a.submittedAt),
        suspendedAt: a.suspendedAt,
        suspendSource: n?.suspendSource ?? null,
        stillSuspended: n?.isSuspended === true,
        decisionReason: a.decisionReason ?? null,
        decidedAt: ms(a.decidedAt) || null,
      }
    }),
  }
})

export const adminDecideAppeal = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  const f = (request.data ?? {}) as Record<string, unknown>
  const id = typeof f.id === 'string' && !f.id.includes('/') ? f.id : ''
  const decision = f.decision === 'upheld' || f.decision === 'overturned' ? f.decision : null
  const reason = typeof f.reason === 'string' ? f.reason.trim().slice(0, 500) : ''
  if (!id || !decision) throw new HttpsError('invalid-argument', 'id and decision required')
  if (reason.length < 5) throw new HttpsError('invalid-argument', 'A reason is required.')
  const ref = db().doc(`appeals/${id}`)
  const a = (await ref.get()).data()
  const by = await requireAdminAudited(request.auth, { action: 'appeal.decide', target: a?.uid ?? null, reason, detail: { id, decision } })
  if (!a) throw new HttpsError('not-found', 'No such appeal.')
  if (a.status !== 'pending') throw new HttpsError('failed-precondition', 'Already decided.')
  // The appeal (note included) is kept with the decision record: 2 years.
  await ref.update({ status: decision, decidedBy: by, decidedAt: FieldValue.serverTimestamp(), decisionReason: reason, expiresAt: Timestamp.fromMillis(Date.now() + OUTCOME_RETENTION_MS) })
  if (decision === 'overturned') {
    await liftSuspension(a.uid)
    await refreshEntry(a.uid)
  }
  await resumeEvidenceFor(a.uid, decision)
  return { ok: true }
})
