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
import { isPlayId, modeOfId, playIdOf, uidOfPlayId } from './playIds'
import { generationOf } from './matchGeneration'
import { afterLift, blockModes } from './blockCore'

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

// The generations of this match both people were in — the live match doc's,
// and those of the 90-day records behavior.ts keeps when a match ends
// (pastConnections/{matchId}_{generation}, or {matchId} for records from
// before generations, as 0). Empty: they weren't matched here.
// The generation a report (and its evidence) is filed under (F-070): the
// claimed one if it's a real match between them, else their latest; null if
// they never matched here.
export async function reportGeneration(matchId: string, a: string, b: string, claimed: number): Promise<number | null> {
  const gens = await matchGenerations(matchId, a, b)
  if (!gens.length) return null
  return gens.includes(claimed) ? claimed : Math.max(...gens)
}

export async function matchGenerations(matchId: string, a: string, b: string): Promise<number[]> {
  const db = getFirestore()
  const both = (data: DocumentData | undefined) => {
    const users = participants(data)
    return users.includes(a) && users.includes(b)
  }
  const out = new Set<number>()
  // F-062: a live Play match's people are in its server-only record.
  const live = await loadMatch(matchId)
  if (live && live.pair.includes(a) && live.pair.includes(b)) out.add(generationOf(live.data))
  const legacy = (await db.collection('pastConnections').doc(matchId).get()).data()
  if (both(legacy)) out.add(0)
  const past = await db.collection('pastConnections').where('matchId', '==', matchId).get()
  for (const d of past.docs) if (both(d.data())) out.add(typeof d.get('generation') === 'number' ? (d.get('generation') as number) : 0)
  return [...out]
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
  const refusal = uid ? await carrySuspension(uid, phone).then(() => suspensionRefusal(uid)).catch((err: unknown) => {
    logger.error('onBeforeSignIn: suspension lookup failed, allowing sign-in', { message: err instanceof Error ? err.message : String(err) })
    return null
  }) : null
  if (refusal) throw new HttpsError('permission-denied', refusal)
})

// F-067: an account deleted while suspended doesn't come back clean as a new
// one on the same number — its suspension (deletedAccounts, recoveryRecord)
// is applied to the new account here, before it's in, with the same appeal
// path. Once it has ended (or been lifted on appeal) there's nothing to carry.
export async function carrySuspension(uid: string, phone: string): Promise<void> {
  const db = getFirestore()
  const recovery = (await db.doc(`deletedAccounts/${phone}`).get()).data()
  const s = recovery?.suspension as DocumentData | null | undefined
  if (!s || recovery?.previousUid === uid) return
  const until = s.suspendedUntil instanceof Timestamp ? s.suspendedUntil.toMillis() : null
  if (until !== null && until <= Date.now()) return
  const internalRef = db.doc(`userInternal/${uid}`)
  if ((await internalRef.get()).data()?.isSuspended === true) return
  await internalRef.set(
    {
      isSuspended: true,
      suspendedAt: s.suspendedAt ?? Timestamp.now(),
      suspendedUntil: s.suspendedUntil ?? null,
      suspendedPendingReview: s.suspendedPendingReview === true || until === null,
      suspendSource: s.suspendSource ?? 'admin',
      suspendReason: s.suspendReason ?? null,
      suspendedBy: s.suspendedBy ?? null,
      reportCount: typeof recovery?.reportCount === 'number' ? recovery.reportCount : 0,
      carriedFrom: recovery?.previousUid ?? null,
    },
    { merge: true },
  )
  logger.warn('onBeforeSignIn: suspension carried over from a deleted account')
}

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
    // H3: a block may hold in both modes (modes); one with no mode is Spark's here.
    const modes = blockModes(d.data()) ?? ['spark']
    if (by === uid && (!mode || modes.includes(mode))) mine.add(d.id)
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
    await liftBlock(request.auth.uid, targetUid, modeOfId(target))
    return { success: true }
  },
)

// Lifts a block the caller placed (unblockMember, and mobile's unblockUser).
// F-065: only a block in `mode` (the mode of the id the caller used) — a uid
// can't lift a Play block nor a Play ID a Spark one, so "not found" can't tell
// whether a uid and a Play ID are the same person. C1: only the person who
// placed it (blockedBy, which blocking never rewrites). H3: a block placed
// in both modes is lifted in this one only.
export async function liftBlock(uid: string, targetUid: string, mode: 'spark' | 'play'): Promise<void> {
  if (!(await blockedByCaller(uid, mode)).has(targetUid)) {
    throw new HttpsError('not-found', "You haven't blocked this person")
  }
  const db = getFirestore()
  const mineRef = db.doc(`users/${uid}/blockedUsers/${targetUid}`)
  const theirsRef = db.doc(`users/${targetUid}/blockedUsers/${uid}`)
  const rest = afterLift((await mineRef.get()).data(), mode)
  const batch = db.batch()
  if (rest === 'delete') {
    const legacy = await db.collection('blocks').where('blockerUid', '==', uid).where('blockedUid', '==', targetUid).get()
    batch.delete(mineRef)
    batch.delete(theirsRef)
    for (const d of legacy.docs) batch.delete(d.ref)
  } else {
    for (const ref of [mineRef, theirsRef]) batch.set(ref, { modes: rest, mode: rest[0] }, { merge: true })
  }
  await batch.commit()
  // Explore (Stage 3): they can see each other again (in this mode, H3).
  await setBlocked(uid, targetUid, rest === 'delete' ? [] : rest)
}

// ─── Photo consent ───────────────────────────────────────────────────────────
// Firestore rules stop clients setting photoConsent.status to 'accepted';
// this is the only way in. The request must be backed by a real request
// message from the other person (messages can only be written as yourself),
// so nobody can fake a request "from" their match and accept it themselves.

const CONSENT_CODES = ['photo_consent_request', 'photo_consent_declined', 'photo_consent_paused', 'photo_consent_accepted']

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
    if (!ctx || !ctx.has(uid)) throw new HttpsError('permission-denied', 'Not a participant')
    const matchRef = ctx.ref
    const me = ctx.idOf(uid)

    // T&S Phase 2: no chat photos while either person is on probation.
    const people = ctx.users
    if ((await Promise.all(people.map((p) => probationOf(p)))).some((p) => p?.noChatPhotos)) {
      throw new HttpsError('failed-precondition', 'Photo sharing opens up once both accounts are a little older.')
    }

    // F-077: the latest consent message of ANY kind must be a request from
    // the person named — a request from before a pause, a decline or an
    // earlier acceptance can't be replayed by re-marking the match pending.
    const consent = await db.collection(messagesPath(matchId)).where('ciphertext', 'in', CONSENT_CODES).get()
    const latest = consent.docs
      .map((d) => d.data())
      .filter((m) => m.messageType === 'consent_request')
      .sort((a, b) => (b.sentAt?.toMillis?.() ?? 0) - (a.sentAt?.toMillis?.() ?? 0))[0]
    const latestRequester = latest?.ciphertext === 'photo_consent_request' ? (latest.senderId as string | undefined) : undefined

    await db.runTransaction(async (tx) => {
      const match = (await tx.get(matchRef)).data()
      if (!match) throw new HttpsError('permission-denied', 'Not a participant')
      // F-077: not on a chat that's been blocked or ended.
      if (match.isBlocked === true || match.unmatchedAt != null) throw new HttpsError('failed-precondition', 'This conversation has ended.')
      const pending = (match.photoConsent ?? {}) as Record<string, unknown>
      if (pending.status !== 'pending') throw new HttpsError('failed-precondition', 'No pending photo request')
      if (pending.requestedBy === me) throw new HttpsError('failed-precondition', "You can't accept your own request")
      if (!latestRequester || latestRequester !== pending.requestedBy) {
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
