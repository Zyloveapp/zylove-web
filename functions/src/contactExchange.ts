import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { generationOf, participants } from './matchGeneration'
import { requireActive } from './userData'

// T&S Phase 3 — contact exchange ("Share contact"), like photo consent with
// the rule gap closed. The state lives in matches/{id}.contactExchange
// (server-only — clients can't write it):
//   { status: 'pending' | 'accepted' | 'declined' | 'revoked',
//     requestedBy, requestedAt, respondedAt?, shareBack?, revokedBy?, revokedAt? }
// Cards are contact_card messages, end-to-end encrypted on the sender's
// device; Firestore rules accept one only while the exchange is accepted —
// from the requester, or from the other person if they chose to share back.
// Only these callables move the state, and the request is refused until
// both people have sent at least UNLOCK_MESSAGES messages in this match.
// Either person may ask, in Spark and Play; never with a curated profile.
// Revoke blanks every card in the chat for both people.

export const UNLOCK_MESSAGES = 3
const FAST_AFTER_UNLOCK_MS = 5 * 60 * 1000
const REQUESTS_KEPT = 50
const DAY_MS = 24 * 60 * 60 * 1000
const db = () => getFirestore()
const isBot = (uid: string) => /^(zbot|seed)-/.test(uid)
const ms = (v: unknown): number => (v instanceof Timestamp ? v.toMillis() : typeof v === 'number' ? v : 0)

function matchIdArg(data: unknown): string {
  const id = (data as Record<string, unknown> | null)?.matchId
  if (typeof id !== 'string' || !id || id.includes('/')) throw new HttpsError('invalid-argument', 'matchId required')
  return id
}

// When both people had sent UNLOCK_MESSAGES real messages (text or photo)
// in this match generation, or null if they haven't yet. Pure.
export function unlockedAt(messages: { senderId: unknown; sentAt: number; messageType?: unknown; nonce?: unknown }[], people: string[], since: number): number | null {
  const times = new Map<string, number[]>(people.map((p) => [p, []]))
  for (const m of messages) {
    const type = m.messageType ?? 'text'
    if (m.nonce === 'system' || (type !== 'text' && type !== 'photo') || m.sentAt < since) continue
    if (typeof m.senderId === 'string') times.get(m.senderId)?.push(m.sentAt)
  }
  let at = 0
  for (const p of people) {
    const t = (times.get(p) ?? []).sort((a, b) => a - b)
    if (t.length < UNLOCK_MESSAGES) return null
    at = Math.max(at, t[UNLOCK_MESSAGES - 1])
  }
  return at
}

async function liveMatch(matchId: string, uid: string): Promise<{ ref: FirebaseFirestore.DocumentReference; match: DocumentData; people: string[] }> {
  const ref = db().doc(`matches/${matchId}`)
  const match = (await ref.get()).data()
  const people = participants(match)
  if (!match || !people.includes(uid)) throw new HttpsError('permission-denied', 'Not a participant')
  if (match.isBot === true || people.some(isBot)) throw new HttpsError('failed-precondition', "Contact details can't be shared with a curated profile.")
  if (match.isBlocked === true || match.unmatchedAt || match.endedAt) throw new HttpsError('failed-precondition', 'This conversation has ended.')
  return { ref, match, people }
}

function notice(code: string, uid: string) {
  return { senderId: uid, messageType: 'contact_request', ciphertext: code, nonce: 'system', sentAt: FieldValue.serverTimestamp(), status: 'sent' }
}

// Counts only (T&S Phase 1 signals): every request, and how soon after the
// chat unlocked it came. contactRequests { total, fastAfterUnlock, recent: [{at, fast}] }.
async function recordRequestSignal(uid: string, fast: boolean): Promise<void> {
  const ref = db().doc(`behaviorSignals/${uid}`)
  await db().runTransaction(async (tx) => {
    const cur = ((await tx.get(ref)).data()?.contactRequests ?? {}) as { total?: number; fastAfterUnlock?: number; recent?: { at: number; fast: boolean }[] }
    const now = Date.now()
    tx.set(
      ref,
      {
        contactRequests: {
          total: (cur.total ?? 0) + 1,
          fastAfterUnlock: (cur.fastAfterUnlock ?? 0) + (fast ? 1 : 0),
          recent: [...(cur.recent ?? []).filter((r) => now - r.at < 7 * DAY_MS), { at: now, fast }].slice(-REQUESTS_KEPT),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
  })
}

export const requestContactExchange = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  await requireActive(uid)
  const matchId = matchIdArg(request.data)
  const { ref, match, people } = await liveMatch(matchId, uid)
  const status = (match.contactExchange as DocumentData | undefined)?.status
  if (status === 'pending') throw new HttpsError('failed-precondition', 'A contact request is already waiting for an answer.')
  if (status === 'accepted') throw new HttpsError('failed-precondition', 'You already shared contact details here.')
  const since = generationOf(match)
  const snap = await ref.collection('messages').select('senderId', 'sentAt', 'messageType', 'nonce').get()
  const unlocked = unlockedAt(
    snap.docs.map((d) => ({ senderId: d.get('senderId'), sentAt: ms(d.get('sentAt')), messageType: d.get('messageType'), nonce: d.get('nonce') })),
    people,
    since,
  )
  if (unlocked === null) throw new HttpsError('failed-precondition', `Share contact unlocks once you've both sent ${UNLOCK_MESSAGES} messages.`)
  const batch = db().batch()
  batch.update(ref, { contactExchange: { status: 'pending', requestedBy: uid, requestedAt: Date.now() } })
  batch.create(ref.collection('messages').doc(), notice('contact_request', uid))
  await batch.commit()
  await recordRequestSignal(uid, Date.now() - unlocked < FAST_AFTER_UNLOCK_MS)
  logger.info('requestContactExchange')
  return { ok: true }
})

export const respondContactExchange = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  await requireActive(uid)
  const data = (request.data ?? {}) as Record<string, unknown>
  const matchId = matchIdArg(data)
  if (typeof data.accept !== 'boolean') throw new HttpsError('invalid-argument', 'accept required')
  const shareBack = data.accept && data.shareBack === true
  const { ref } = await liveMatch(matchId, uid)
  await db().runTransaction(async (tx) => {
    const ce = ((await tx.get(ref)).data()?.contactExchange ?? {}) as DocumentData
    if (ce.status !== 'pending') throw new HttpsError('failed-precondition', 'No contact request is waiting.')
    if (ce.requestedBy === uid) throw new HttpsError('failed-precondition', "You can't answer your own request.")
    tx.update(ref, {
      'contactExchange.status': data.accept ? 'accepted' : 'declined',
      'contactExchange.respondedAt': Date.now(),
      'contactExchange.shareBack': shareBack,
    })
    tx.create(ref.collection('messages').doc(), notice(data.accept ? 'contact_accepted' : 'contact_declined', uid))
  })
  return { ok: true }
})

export const revokeContactExchange = onCall({ timeoutSeconds: 60, memory: '256MiB', invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  const matchId = matchIdArg(request.data)
  const ref = db().doc(`matches/${matchId}`)
  const match = (await ref.get()).data()
  if (!match || !participants(match).includes(uid)) throw new HttpsError('permission-denied', 'Not a participant')
  const status = (match.contactExchange as DocumentData | undefined)?.status
  if (status !== 'accepted' && status !== 'pending') throw new HttpsError('failed-precondition', 'Nothing to take back.')
  await ref.update({ 'contactExchange.status': 'revoked', 'contactExchange.revokedBy': uid, 'contactExchange.revokedAt': Date.now() })
  // Every card in the chat, for both people: the encrypted payload goes.
  const cards = await ref.collection('messages').where('messageType', '==', 'contact_card').get()
  const batch = db().batch()
  for (const d of cards.docs) batch.update(d.ref, { ciphertext: '', nonce: 'revoked', revokedAt: Date.now() })
  batch.create(ref.collection('messages').doc(), notice('contact_revoked', uid))
  await batch.commit()
  return { ok: true, cardsRemoved: cards.size }
})
