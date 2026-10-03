import { createHash } from 'node:crypto'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { beforeUserSignedIn } from 'firebase-functions/v2/identity'
import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'

// Trust & safety: phone-level bans, the caller's blocked list, and
// server-side photo consent acceptance.

const SERIOUS = ['felt_unsafe', 'aggressive', 'pushed_boundaries', 'inappropriate']
const SUSPEND_AT = 3 // distinct reporters → account suspended
const SIGN_IN_BLOCKED_AT = 2 // distinct reporters → phone can't sign in
const BOT_PREFIXES = ['zbot-', 'seed-']

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

// Both people were in this match: a live match doc, or the 90-day record
// behavior.ts keeps once mobile's unmatch deletes it.
async function wereMatched(matchId: string, a: string, b: string): Promise<boolean> {
  const db = getFirestore()
  for (const ref of [db.collection('matches').doc(matchId), db.collection('pastConnections').doc(matchId)]) {
    const users = participants((await ref.get()).data())
    if (users.includes(a) && users.includes(b)) return true
  }
  return false
}

// ─── Phone-level ban ─────────────────────────────────────────────────────────

// Called alongside submitReview when a report is serious. Counts distinct
// reporters per phone, so one person reporting repeatedly can't get someone
// banned on their own.
export const reportAndBan = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const callerUid = request.auth.uid
    const reportedUid = str(request.data, 'reportedUid')
    const matchId = str(request.data, 'matchId')
    const rawCategories: unknown = (request.data as Record<string, unknown>).categories
    const categories = Array.isArray(rawCategories)
      ? rawCategories.filter((c): c is string => typeof c === 'string').slice(0, 24)
      : []
    const severity = (request.data as Record<string, unknown>).severity === 'urgent' ? 'urgent' : 'standard'
    if (reportedUid === callerUid) throw new HttpsError('invalid-argument', 'Cannot report yourself')
    if (BOT_PREFIXES.some((p) => reportedUid.startsWith(p))) return { success: true }
    if (!(await wereMatched(matchId, callerUid, reportedUid))) {
      throw new HttpsError('permission-denied', 'You can only report people you matched with')
    }

    const db = getFirestore()
    await db.collection('reviewQueue').add({
      reporterUid: callerUid,
      reportedUid,
      matchId,
      categories,
      severity,
      source: 'reportAndBan',
      createdAt: FieldValue.serverTimestamp(),
    })

    if (severity !== 'urgent' && !categories.some((c) => SERIOUS.includes(c))) return { success: true }

    const phone = await getAuth()
      .getUser(reportedUid)
      .then((u) => u.phoneNumber ?? null)
      .catch(() => null)
    if (!phone) {
      logger.warn('reportAndBan: reported user has no phone number', { matchId })
      return { success: true }
    }

    const banRef = db.collection('bannedPhones').doc(phoneHash(phone))
    const reporters = await db.runTransaction(async (tx) => {
      const existing = (await tx.get(banRef)).data()
      const reportedBy = Array.isArray(existing?.reportedBy) ? (existing.reportedBy as string[]) : []
      const isNew = !reportedBy.includes(callerUid)
      const count = reportedBy.length + (isNew ? 1 : 0)
      tx.set(
        banRef,
        {
          phoneHash: banRef.id,
          reportCount: count,
          reportedBy: FieldValue.arrayUnion(callerUid),
          categories: FieldValue.arrayUnion(...(categories.length > 0 ? categories : [severity])),
          lastReportedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      return count
    })

    if (reporters >= SUSPEND_AT) {
      await db.collection('users').doc(reportedUid).update({ isSuspended: true }).catch(() => {})
      logger.warn('reportAndBan: account suspended', { reporters })
    }
    return { success: true }
  },
)

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
})

// ─── Blocked users ───────────────────────────────────────────────────────────
// Mobile's blockUser writes users/{a}/blockedUsers/{b} AND users/{b}/blockedUsers/{a}
// with no direction, so the list alone can't say who blocked whom. Direction
// comes from the match (blockedBy) or the legacy blocks collection; blocks
// with no record of who did it (mobile blocks from a profile) are left out
// rather than risk showing — or letting someone undo — a block placed on them.

async function blockedByCaller(uid: string): Promise<Map<string, number>> {
  const db = getFirestore()
  const [mirror, matches, legacy] = await Promise.all([
    db.collection(`users/${uid}/blockedUsers`).get(),
    db.collection('matches').where('blockedBy', '==', uid).get(),
    db.collection('blocks').where('blockerUid', '==', uid).get(),
  ])
  const mine = new Set<string>()
  for (const m of matches.docs) {
    const other = participants(m.data()).find((u) => u !== uid)
    if (other) mine.add(other)
  }
  for (const b of legacy.docs) {
    const other: unknown = b.data().blockedUid
    if (typeof other === 'string') mine.add(other)
  }
  const result = new Map<string, number>()
  for (const d of mirror.docs) {
    if (!mine.has(d.id)) continue
    const at: unknown = d.data().blockedAt
    result.set(d.id, at instanceof Timestamp ? at.toMillis() : 0)
  }
  return result
}

export const getBlockedUsers = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ blocked: { uid: string; name: string; blockedAt: number }[] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const blocked = await blockedByCaller(request.auth.uid)
    const db = getFirestore()
    const rows = await Promise.all(
      [...blocked].map(async ([uid, blockedAt]) => {
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
    const uid = request.auth.uid
    const targetUid = str(request.data, 'targetUid')
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
    return { success: true }
  },
)

// ─── Photo consent ───────────────────────────────────────────────────────────
// Firestore rules stop clients setting photoConsent.status to 'accepted';
// this is the only way in. The request must be backed by a real request
// message from the other person (messages can only be written as yourself),
// so nobody can fake a request "from" their match and accept it themselves.

export const acceptPhotoConsent = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const matchId = str(request.data, 'matchId')
    const db = getFirestore()
    const matchRef = db.collection('matches').doc(matchId)

    const requests = await matchRef.collection('messages').where('ciphertext', '==', 'photo_consent_request').get()
    const latestRequester = requests.docs
      .map((d) => d.data())
      .filter((m) => m.messageType === 'consent_request')
      .sort((a, b) => (b.sentAt?.toMillis?.() ?? 0) - (a.sentAt?.toMillis?.() ?? 0))[0]?.senderId as string | undefined

    await db.runTransaction(async (tx) => {
      const match = (await tx.get(matchRef)).data()
      if (!match || !participants(match).includes(uid)) throw new HttpsError('permission-denied', 'Not a participant')
      const consent = (match.photoConsent ?? {}) as Record<string, unknown>
      if (consent.status !== 'pending') throw new HttpsError('failed-precondition', 'No pending photo request')
      if (consent.requestedBy === uid) throw new HttpsError('failed-precondition', "You can't accept your own request")
      if (!latestRequester || latestRequester !== consent.requestedBy) {
        throw new HttpsError('failed-precondition', 'No matching photo request')
      }
      tx.update(matchRef, {
        'photoConsent.status': 'accepted',
        'photoConsent.acceptedAt': FieldValue.serverTimestamp(),
        'photoConsent.acceptedBy': uid,
      })
      // Same system-message format both apps render.
      tx.create(matchRef.collection('messages').doc(), {
        senderId: uid,
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
