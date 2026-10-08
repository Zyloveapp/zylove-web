// Founder messages: a private line between each founder and Matthew.
//
//   founderMessages/{uid}                 thread summary for the admin inbox
//                                         (adminUnread, last message, name)
//   founderMessages/{uid}/thread/{id}     the messages
//   users/{uid}.founderThreadMeta         the founder's own summary
//                                         (hasUnread = an admin reply unread)
//
// Everything goes through these callables; there are no client rules for
// founderMessages, so the collection is server-only (rules default-deny).
// Founders read their own thread with getFounderThread.

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData, type WriteBatch } from 'firebase-admin/firestore'
import { accountRef, isAdminAuth, requireActive } from './userData'
import { audit } from './audit'
import { SMS_SECRETS, textAccount } from './sms'
import { queueAdminAlert } from './adminAlerts'

const MAX_BODY = 1000
const PREVIEW_CHARS = 60
const ADMIN_NAME = 'Matthew · Zylove Founder'
const BOT_PREFIX = 'zbot-'
// Revoked and converted founders no longer have isFounder, but be explicit.
const FORMER_STATUSES = new Set(['revoked', 'converted'])

function db() {
  return getFirestore()
}

function parseBody(data: unknown): string {
  const raw = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).body : undefined
  const body = typeof raw === 'string' ? raw.trim() : ''
  if (!body) throw new HttpsError('invalid-argument', 'Message is empty')
  if (body.length > MAX_BODY) throw new HttpsError('invalid-argument', `Message is over ${MAX_BODY} characters`)
  return body
}

function parseUid(v: unknown): string {
  if (typeof v !== 'string' || !v || v.includes('/')) throw new HttpsError('invalid-argument', 'founderUid required')
  return v
}

const preview = (body: string, n = PREVIEW_CHARS) => (body.length > n ? `${body.slice(0, n).trimEnd()}…` : body)

function displayName(user: DocumentData | undefined): string {
  const n: unknown = user?.displayName
  return typeof n === 'string' && n.trim() ? n.trim() : 'A founder'
}

// Revoked and converted founders have isFounder false (founderActivity.ts);
// older docs may still carry a public founderStatus.
function isActiveFounder(id: string, user: DocumentData): boolean {
  return !id.startsWith(BOT_PREFIX) && user.isFounder === true && !FORMER_STATUSES.has(String(user.founderStatus))
}

function requireAdmin(auth: { uid: string; token?: Record<string, unknown> } | undefined): string {
  if (!auth) throw new HttpsError('unauthenticated', 'Login required')
  if (!isAdminAuth(auth)) throw new HttpsError('permission-denied', 'Admins only')
  return auth.uid
}

async function activeFounders(): Promise<{ id: string; data: DocumentData }[]> {
  const snap = await db().collection('users').where('isFounder', '==', true).get()
  return snap.docs.filter((d) => isActiveFounder(d.id, d.data())).map((d) => ({ id: d.id, data: d.data() }))
}

// Adds one admin message to a founder's thread (batched by the caller).
function writeAdminMessage(batch: WriteBatch, adminUid: string, founderUid: string, founder: DocumentData, body: string) {
  const threadRef = db().doc(`founderMessages/${founderUid}`)
  const now = FieldValue.serverTimestamp()
  batch.set(threadRef.collection('thread').doc(), {
    fromUid: adminUid,
    fromName: ADMIN_NAME,
    isFromAdmin: true,
    body,
    createdAt: now,
    readAt: null,
  })
  batch.set(
    threadRef,
    {
      uid: founderUid,
      displayName: displayName(founder),
      founderCity: founder.founderCity ?? null,
      founderBadge: founder.founderBadge ?? null,
      lastMessageAt: now,
      lastMessagePreview: preview(body),
      lastFromAdmin: true,
      totalMessages: FieldValue.increment(1),
    },
    { merge: true },
  )
  // Stage B (F-056): message previews in the owner's private/account, not
  // on the public profile.
  batch.set(
    accountRef(founderUid),
    {
      founderThreadMeta: {
        hasUnread: true,
        lastMessageAt: now,
        lastMessagePreview: preview(body),
        totalMessages: FieldValue.increment(1),
      },
    },
    { merge: true },
  )
}

function millis(v: unknown): number | null {
  return v instanceof Timestamp ? v.toMillis() : null
}

// ─── Founder → Matthew ───────────────────────────────────────────────────────

export const sendFounderMessage = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    await requireActive(request.auth.uid)
    const uid = request.auth.uid
    const body = parseBody(request.data)
    const user = (await db().doc(`users/${uid}`).get()).data()
    // The admin is the recipient: their own founder badge doesn't give them a thread.
    if (isAdminAuth(request.auth)) throw new HttpsError('failed-precondition', "You can't send a message to yourself.")
    if (!user || !isActiveFounder(uid, user)) throw new HttpsError('permission-denied', 'Founders only')

    const name = displayName(user)
    const threadRef = db().doc(`founderMessages/${uid}`)
    const now = FieldValue.serverTimestamp()
    const batch = db().batch()
    batch.set(threadRef.collection('thread').doc(), {
      fromUid: uid,
      fromName: name,
      isFromAdmin: false,
      body,
      createdAt: now,
      readAt: null,
    })
    batch.set(
      threadRef,
      {
        uid,
        displayName: name,
        founderCity: user.founderCity ?? null,
        founderBadge: user.founderBadge ?? null,
        lastMessageAt: now,
        lastMessagePreview: preview(body),
        lastFromAdmin: false,
        totalMessages: FieldValue.increment(1),
        adminUnread: true,
      },
      { merge: true },
    )
    batch.set(
      accountRef(uid),
      {
        founderThreadMeta: {
          hasUnread: false,
          lastMessageAt: now,
          lastMessagePreview: preview(body),
          totalMessages: FieldValue.increment(1),
        },
      },
      { merge: true },
    )
    await batch.commit()

    // The admin's text (adminAlerts.ts): a count and a link, never who or what.
    await queueAdminAlert('founderMessage', { subjectUid: uid })
    logger.info('sendFounderMessage')
    return { success: true }
  },
)

// ─── Matthew → one founder ───────────────────────────────────────────────────

export const replyToFounder = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public', secrets: SMS_SECRETS },
  async (request): Promise<{ success: true }> => {
    const adminUid = requireAdmin(request.auth)
    await audit({ actor: adminUid, action: 'founder.reply', target: typeof request.data?.founderUid === 'string' ? request.data.founderUid : null })
    const data = (request.data ?? {}) as Record<string, unknown>
    const founderUid = parseUid(data.founderUid)
    const body = parseBody(data)
    const founder = (await db().doc(`users/${founderUid}`).get()).data()
    if (!founder) throw new HttpsError('not-found', 'Founder not found')

    const batch = db().batch()
    writeAdminMessage(batch, adminUid, founderUid, founder, body)
    // Replying means the admin has read the thread.
    batch.set(db().doc(`founderMessages/${founderUid}`), { adminUnread: false }, { merge: true })
    await batch.commit()
    await textAccount(founderUid, 'founder', '✦ You have a message from the Zylove founder. Open it at zylove.app — reply STOP to opt out.')
    return { success: true }
  },
)

// ─── Matthew → every founder ─────────────────────────────────────────────────

export const broadcastToFounders = onCall(
  { timeoutSeconds: 300, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ sent: number; failed: number; texted: number; total: number }> => {
    const adminUid = requireAdmin(request.auth)
    await audit({ actor: adminUid, action: 'founder.broadcast' })
    const body = parseBody(request.data)
    const founders = (await activeFounders()).filter((f) => f.id !== adminUid)

    // 3 writes per founder, well under the 500-write batch limit.
    let sent = 0
    let failed = 0
    const delivered: string[] = []
    for (let i = 0; i < founders.length; i += 150) {
      const chunk = founders.slice(i, i + 150)
      const batch = db().batch()
      for (const f of chunk) writeAdminMessage(batch, adminUid, f.id, f.data, body)
      try {
        await batch.commit()
        sent += chunk.length
        delivered.push(...chunk.map((f) => f.id))
      } catch (err) {
        failed += chunk.length
        logger.error('broadcastToFounders: batch failed', { message: err instanceof Error ? err.message : String(err) })
      }
    }

    // No texts: a broadcast is an announcement, and SMS is account and
    // match/message notifications only. Founders see it in their thread.
    // texted stays in the result for clients still on the old build.
    const texted = 0
    logger.info('broadcastToFounders', { total: founders.length, sent, failed, texted })
    return { sent, failed, texted, total: founders.length }
  },
)

// ─── Reading ─────────────────────────────────────────────────────────────────

export const markFounderThreadRead = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const unread = await db()
      .collection(`founderMessages/${uid}/thread`)
      .where('isFromAdmin', '==', true)
      .where('readAt', '==', null)
      .get()
    const batch = db().batch()
    for (const d of unread.docs) batch.update(d.ref, { readAt: FieldValue.serverTimestamp() })
    batch.set(accountRef(uid), { founderThreadMeta: { hasUnread: false } }, { merge: true })
    await batch.commit()
    return { success: true }
  },
)

export interface FounderThreadSummary {
  uid: string
  displayName: string
  founderCity: string | null
  founderBadge: string | null
  lastMessageAt: number | null
  lastMessagePreview: string
  // The founder wrote something the admin hasn't opened.
  hasUnread: boolean
  totalMessages: number
}

export const getFounderThreads = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ threads: FounderThreadSummary[]; founderCount: number }> => {
    const adminUid = requireAdmin(request.auth)
    await audit({ actor: adminUid, action: 'founder.threads_list' })
    const [snap, founders] = await Promise.all([
      db().collection('founderMessages').orderBy('lastMessageAt', 'desc').get(),
      activeFounders(),
    ])
    const threads = snap.docs.map((d): FounderThreadSummary => {
      const t = d.data()
      return {
        uid: d.id,
        displayName: typeof t.displayName === 'string' ? t.displayName : 'A founder',
        founderCity: typeof t.founderCity === 'string' ? t.founderCity : null,
        founderBadge: typeof t.founderBadge === 'string' ? t.founderBadge : null,
        lastMessageAt: millis(t.lastMessageAt),
        lastMessagePreview: typeof t.lastMessagePreview === 'string' ? t.lastMessagePreview : '',
        hasUnread: t.adminUnread === true,
        totalMessages: typeof t.totalMessages === 'number' ? t.totalMessages : 0,
      }
    })
    return { threads, founderCount: founders.filter((f) => f.id !== adminUid).length }
  },
)

export interface FounderMessage {
  id: string
  fromUid: string
  fromName: string
  isFromAdmin: boolean
  body: string
  createdAt: number | null
  readAt: number | null
}

// Admins read any founder's thread (and it counts as read); anyone else
// reads only their own (founderUid omitted or their uid).
export const getFounderThread = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ messages: FounderMessage[] }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const caller = request.auth.uid
    const asked = (request.data as Record<string, unknown> | null)?.founderUid
    const founderUid = asked === undefined || asked === null ? caller : parseUid(asked)
    if (founderUid !== caller) {
      requireAdmin(request.auth)
      await audit({ actor: caller, action: 'founder.thread_view', target: founderUid })
    }

    const snap = await db().collection(`founderMessages/${founderUid}/thread`).orderBy('createdAt', 'asc').get()
    if (founderUid !== caller) {
      await db().doc(`founderMessages/${founderUid}`).set({ adminUnread: false }, { merge: true })
    }
    return {
      messages: snap.docs.map((d) => {
        const m = d.data()
        return {
          id: d.id,
          fromUid: String(m.fromUid ?? ''),
          fromName: String(m.fromName ?? ''),
          isFromAdmin: m.isFromAdmin === true,
          body: String(m.body ?? ''),
          createdAt: millis(m.createdAt),
          readAt: millis(m.readAt),
        }
      }),
    }
  },
)
