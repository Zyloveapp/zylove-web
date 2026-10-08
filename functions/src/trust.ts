import { createHash } from 'node:crypto'
import { requireActive } from './userData'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { beforeUserSignedIn } from 'firebase-functions/v2/identity'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { loadPlayName } from './playName'
import { connectionMode } from './behavior'
import { setBlocked } from './explore'
import { suspensionRefusal } from './appeals'
import { probationOf } from './probation'
import { loadMatch, messagesPath } from './playMatch'
import { isPlayId, playIdOf, uidOfPlayId } from './playIds'

// Trust & safety: phone-level bans, the caller's blocked list, and
// server-side photo consent acceptance.

const SIGN_IN_BLOCKED_AT = 2 // distinct reporters → phone can't sign in

function participants(d: DocumentData | undefined): string[] {
  const users: unknown = d?.users ?? d?.participants
  return Array.isArray(users) ? users.filter((u): u is string => typeof u === 'string') : []
}

function str(data: unknown, key: string): string {
  const v = (data as Record<string, unknown> | null)?.[key]
  if (typeof v !== 'string' || !v) throw new HttpsError('invalid-argument', `${key} required`)
  return v
}

// Raw numbers are never stored — only this digest.
export function phoneHash(phone: string): string {
  return createHash('sha256').update(phone.trim()).digest('hex')
}

// Both people were in this match: a live match doc, or one of the 90-day
// records behavior.ts keeps when a match ends — pastConnections/
// {matchId}_{generation}, or {matchId} for records from before generations.
export async function wereMatched(matchId: string, a: string, b: string): Promise<boolean> {
  const db = getFirestore()
  const both = (data: DocumentData | undefined) => {
    const users = participants(data)
    return users.includes(a) && users.includes(b)
  }
  // F-062: a live Play match's people are in its server-only record.
  const live = await loadMatch(matchId)
  if (live && live.users.includes(a) && live.users.includes(b)) return true
  if (both((await db.collection('pastConnections').doc(matchId).get()).data())) return true
  const past = await db.collection('pastConnections').where('matchId', '==', matchId).get()
  return past.docs.some((d) => both(d.data()))
}

// ─── Phone-level ban ─────────────────────────────────────────────────────────
// Reports (reports.ts) add distinct reporters to bannedPhones/{hash}; an
// admin ban sets a reportCount past any threshold.

// Runs before every sign-in (new and returning). A phone reported by two or
// more people is refused. Any lookup failure lets the sign-in through — an
// outage here must never lock everyone out.
export const onBeforeSignIn = beforeUserSignedIn({ timeoutSeconds: 7, memory: '256MiB' }, async (event) => {
  const phone = event.data?.phoneNumber
  if (!phone) return
  let reportCount = 0
  try {
    const ban = await getFirestore().collection('bannedPhones').doc(phoneHash(phone)).get()
    reportCount = typeof ban.data()?.reportCount === 'number' ? (ban.data()!.reportCount as number) : 0
  } catch (err) {
    logger.error('onBeforeSignIn: ban lookup failed, allowing sign-in', {
      message: err instanceof Error ? err.message : String(err),
    })
    return
  }
  if (reportCount >= SIGN_IN_BLOCKED_AT) {
    throw new HttpsError('permission-denied', 'This phone number can no longer be used on Zylove.')
  }
  // T&S Phase 4: a suspended account is refused here (its Auth account stays
  // enabled so this runs — after the phone was verified), with an appeal token.
  const uid = event.data?.uid
  const refusal = uid ? await suspensionRefusal(uid).catch((err: unknown) => {
    logger.error('onBeforeSignIn: suspension lookup failed, allowing sign-in', { message: err instanceof Error ? err.message : String(err) })
    return null
  }) : null
  if (refusal) throw new HttpsError('permission-denied', refusal)
})

// ─── Blocked users ───────────────────────────────────────────────────────────
// Mobile's blockUser writes users/{a}/blockedUsers/{b} AND users/{b}/blockedUsers/{a}
// with no direction, so the list alone can't say who blocked whom. Direction
// comes from the match (blockedBy) or the legacy blocks collection; blocks
// with no record of who did it (mobile blocks from a profile) are left out
// rather than risk showing — or letting someone undo — a block placed on them.

// Who the caller blocked, with when. With a mode, only blocks made from that
// mode's matches; legacy blocks (no match, no mode) count as Spark.
async function blockedByCaller(uid: string, mode: 'spark' | 'play' | null = null): Promise<Map<string, number>> {
  const db = getFirestore()
  const myPlayId = await playIdOf(uid)
  const [mirror, matches, playMatches, legacy] = await Promise.all([
    db.collection(`users/${uid}/blockedUsers`).get(),
    db.collection('matches').where('blockedBy', '==', uid).get(),
    // F-062: Play matches name the blocker by Play ID.
    myPlayId ? db.collection('playMatches').where('blockedBy', '==', myPlayId).get() : Promise.resolve(null),
    db.collection('blocks').where('blockerUid', '==', uid).get(),
  ])
  const mine = new Set<string>()
  // Stage A: blocks record who placed them (blockedBy on the mirror docs,
  // server-written); the match and the legacy collection cover older ones
  // (both server-only now).
  const theirs = new Set<string>()
  for (const d of mirror.docs) {
    const by: unknown = d.data().blockedBy
    if (typeof by !== 'string') continue
    const m: unknown = d.data().mode
    if (by === uid && (!mode || (m === 'play' ? 'play' : 'spark') === mode)) mine.add(d.id)
    else if (by !== uid) theirs.add(d.id)
  }
  for (const m of matches.docs) {
    const other = participants(m.data()).find((u) => u !== uid)
    if (other && (!mode || connectionMode(m.data()) === mode)) mine.add(other)
  }
  if (mode !== 'spark') {
    for (const m of playMatches?.docs ?? []) {
      const other = (await loadMatch(m.id))?.otherOf(uid)
      if (other) mine.add(other)
    }
  }
  if (mode !== 'play') {
    for (const b of legacy.docs) {
      const other: unknown = b.data().blockedUid
      if (typeof other === 'string') mine.add(other)
    }
  }
  const result = new Map<string, number>()
  for (const d of mirror.docs) {
    if (!mine.has(d.id) || theirs.has(d.id)) continue
    const at: unknown = d.data().blockedAt
    result.set(d.id, at instanceof Timestamp ? at.toMillis() : 0)
  }
  return result
}

export const getBlockedUsers = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ blocked: { uid?: string; playId?: string; name: string; blockedAt: number }[] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    // One mode's list (Spark unless asked): a mixed list would name Play
    // blocks by uid.
    const mode = (request.data as { mode?: unknown } | null)?.mode === 'play' ? 'play' : 'spark'
    const blocked = await blockedByCaller(request.auth.uid, mode)
    const db = getFirestore()
    const rows = await Promise.all(
      [...blocked].map(async ([uid, blockedAt]) => {
        // Play's list names them by their Play name and Play ID (F-062),
        // never the Spark name or the uid.
        if (mode === 'play') return { playId: (await playIdOf(uid)) ?? undefined, name: await loadPlayName(uid), blockedAt }
        const name: unknown = (await db.collection('users').doc(uid).get()).data()?.displayName
        return { uid, name: typeof name === 'string' && name ? name : 'Someone', blockedAt }
      }),
    )
    return { blocked: rows.sort((a, b) => b.blockedAt - a.blockedAt) }
  },
)

// Removes a block the caller placed. The match stays ended and behavior
// signals keep the block counted.
export const unblockMember = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    // F-062: from Play's list, the person is named by Play ID.
    const target = str(request.data, 'targetUid')
    const targetUid = isPlayId(target) ? await uidOfPlayId(target) : target
    if (!targetUid) throw new HttpsError('not-found', "You haven't blocked this person")
    await liftBlock(request.auth.uid, targetUid)
    return { success: true }
  },
)

// Lifts a block the caller placed (unblockMember, and mobile's unblockUser).
export async function liftBlock(uid: string, targetUid: string): Promise<void> {
  if (!(await blockedByCaller(uid)).has(targetUid)) {
    throw new HttpsError('not-found', "You haven't blocked this person")
  }
  const db = getFirestore()
  const legacy = await db.collection('blocks').where('blockerUid', '==', uid).where('blockedUid', '==', targetUid).get()
  const batch = db.batch()
  batch.delete(db.doc(`users/${uid}/blockedUsers/${targetUid}`))
  batch.delete(db.doc(`users/${targetUid}/blockedUsers/${uid}`))
  for (const d of legacy.docs) batch.delete(d.ref)
  await batch.commit()
  // Explore (Stage 3): they can see each other again.
  await setBlocked(uid, targetUid, false)
}

// ─── Photo consent ───────────────────────────────────────────────────────────
// Firestore rules stop clients setting photoConsent.status to 'accepted';
// this is the only way in. The request must be backed by a real request
// message from the other person (messages can only be written as yourself),
// so nobody can fake a request "from" their match and accept it themselves.

export const acceptPhotoConsent = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    await requireActive(request.auth.uid)
    const uid = request.auth.uid
    const matchId = str(request.data, 'matchId')
    const db = getFirestore()
    // F-062: a Play match too — its fields and messages name people by Play ID.
    const ctx = await loadMatch(matchId)
    if (!ctx || !ctx.users.includes(uid)) throw new HttpsError('permission-denied', 'Not a participant')
    const matchRef = ctx.ref
    const me = ctx.idOf(uid)

    // T&S Phase 2: no chat photos while either person is on probation.
    const people = ctx.users
    if ((await Promise.all(people.map((p) => probationOf(p)))).some((p) => p?.noChatPhotos)) {
      throw new HttpsError('failed-precondition', 'Photo sharing opens up once both accounts are a little older.')
    }

    const requests = await db.collection(messagesPath(matchId)).where('ciphertext', '==', 'photo_consent_request').get()
    const latestRequester = requests.docs
      .map((d) => d.data())
      .filter((m) => m.messageType === 'consent_request')
      .sort((a, b) => (b.sentAt?.toMillis?.() ?? 0) - (a.sentAt?.toMillis?.() ?? 0))[0]?.senderId as string | undefined

    await db.runTransaction(async (tx) => {
      const match = (await tx.get(matchRef)).data()
      if (!match) throw new HttpsError('permission-denied', 'Not a participant')
      const consent = (match.photoConsent ?? {}) as Record<string, unknown>
      if (consent.status !== 'pending') throw new HttpsError('failed-precondition', 'No pending photo request')
      if (consent.requestedBy === me) throw new HttpsError('failed-precondition', "You can't accept your own request")
      if (!latestRequester || latestRequester !== consent.requestedBy) {
        throw new HttpsError('failed-precondition', 'No matching photo request')
      }
      tx.update(matchRef, {
        'photoConsent.status': 'accepted',
        'photoConsent.acceptedAt': FieldValue.serverTimestamp(),
        'photoConsent.acceptedBy': me,
      })
      // Same system-message format both apps render.
      tx.create(matchRef.collection('messages').doc(), {
        senderId: me,
        messageType: 'consent_request',
        ciphertext: 'photo_consent_accepted',
        nonce: 'system',
        sentAt: FieldValue.serverTimestamp(),
        status: 'sent',
      })
    })
    return { success: true }
  },
)
