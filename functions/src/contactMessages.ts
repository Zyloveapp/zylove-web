import { createHash } from 'node:crypto'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData, type Query } from 'firebase-admin/firestore'
import { requireAdminAudited } from './audit'
import { takeRateLimit } from './rateLimits'
import { queueAdminAlert } from './adminAlerts'

// The /contact form and the admin inbox (/admin/contact).
//   contactMessages/{auto} (server-only)  { name, email, topic, message,
//     createdAt, handled, uid, handledBy?, handledAt? }
// Visitors write through submitContactMessage (signed out is fine), limited
// per caller address and by a daily total so the form can't be used to flood
// the inbox. The address is only hashed into the rate-limit key — never
// stored on the message. Kept 12 months (Privacy Policy), purged by createdAt.

export const CONTACT_MAX_SHORT = 100
export const CONTACT_MAX_LONG = 1000
const MAX_EMAIL = 254
const HOUR_MS = 60 * 60 * 1000
export const CONTACT_PER_IP = { max: 5, windowMs: HOUR_MS }
export const CONTACT_DAILY = { max: 200, windowMs: 24 * HOUR_MS }
const DAILY_KEY = '_contactMessages'
const PAGE_SIZE = 50
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/

const db = () => getFirestore()
const ms = (v: unknown): number | null => (v instanceof Timestamp ? v.toMillis() : null)

type RawRequest = { headers?: Record<string, string | string[] | undefined>; ip?: string; socket?: { remoteAddress?: string } } | undefined

// The caller's address as our own front end saw it: the LAST X-Forwarded-For
// entry (the hop Google appended; anything before it is whatever the client
// sent). Not legal.ts clientIp, which takes the first, client-controlled hop
// — and not req.ip first either, since Express with "trust proxy" on also
// returns that first hop. req.ip / the socket only when there's no header
// (the emulator, direct calls).
export function callerIp(raw: RawRequest): string | null {
  const fwd = raw?.headers?.['x-forwarded-for']
  const hops = (Array.isArray(fwd) ? fwd.join(',') : fwd ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  return (hops[hops.length - 1] || raw?.ip || raw?.socket?.remoteAddress || null)?.slice(0, 64) ?? null
}

// rateLimits/{key} for an address: hashed, the same shape validatePhoneNumber uses.
export function ipRateKey(ip: string | null): string {
  return `ip_${createHash('sha256').update(ip ?? 'unknown').digest('hex').slice(0, 32)}`
}

export interface ContactInput {
  name: string
  email: string
  topic: string
  message: string
}

// The form's fields, checked as the old create rule did (sizes, fixed keys)
// plus a real email. Throws a message for the callable to return.
export function parseContactMessage(raw: unknown): ContactInput {
  const d = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  for (const k of Object.keys(d)) if (!['name', 'email', 'topic', 'message'].includes(k)) throw new Error(`Unknown field ${k}`)
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const name = str(d.name)
  const email = str(d.email).toLowerCase()
  const topic = str(d.topic)
  const message = str(d.message)
  if (!name || name.length > CONTACT_MAX_SHORT) throw new Error(`Add your name (up to ${CONTACT_MAX_SHORT} characters).`)
  if (!EMAIL.test(email) || email.length > MAX_EMAIL) throw new Error('Add a valid email.')
  if (topic.length > CONTACT_MAX_SHORT) throw new Error('Pick a topic from the list.')
  if (!message || message.length > CONTACT_MAX_LONG) throw new Error(`Add a message (up to ${CONTACT_MAX_LONG} characters).`)
  return { name, email, topic, message }
}

export const submitContactMessage = onCall({ timeoutSeconds: 20, memory: '256MiB', invoker: 'public' }, async (request): Promise<{ ok: true }> => {
  let input: ContactInput
  try {
    input = parseContactMessage(request.data)
  } catch (err) {
    throw new HttpsError('invalid-argument', err instanceof Error ? err.message : 'Bad message')
  }
  await takeRateLimit(ipRateKey(callerIp(request.rawRequest as never)), 'contactMessage', CONTACT_PER_IP)
  await takeRateLimit(DAILY_KEY, 'daily', CONTACT_DAILY)
  await db()
    .collection('contactMessages')
    .add({ ...input, createdAt: FieldValue.serverTimestamp(), handled: false, uid: request.auth?.uid ?? null })
  logger.info('submitContactMessage', { signedIn: !!request.auth, topic: input.topic || null })
  await queueAdminAlert('contactMessage')
  return { ok: true }
})

// ─── Admin inbox ─────────────────────────────────────────────────────────────

export type ContactFilter = 'unhandled' | 'handled' | 'all'

export interface ContactRow {
  id: string
  name: string
  email: string
  topic: string
  message: string
  createdAt: number | null
  handled: boolean
  handledAt: number | null
  // The sender's account when they were signed in.
  uid: string | null
}

const docId = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : '')

// Newest first, PAGE_SIZE at a time; `after` is the last id of the previous page.
export const adminListContactMessages = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ messages: ContactRow[]; more: boolean }> => {
    const f = (request.data ?? {}) as Record<string, unknown>
    const filter: ContactFilter = f.filter === 'handled' || f.filter === 'all' ? f.filter : 'unhandled'
    const after = docId(f.after)
    await requireAdminAudited(request.auth, { action: 'contact.list', detail: { filter, page: after ? 'more' : 'first' } })
    let q: Query = db().collection('contactMessages')
    if (filter !== 'all') q = q.where('handled', '==', filter === 'handled')
    q = q.orderBy('createdAt', 'desc')
    if (after) {
      const cursor = await db().doc(`contactMessages/${after}`).get()
      if (cursor.exists) q = q.startAfter(cursor)
    }
    const snap = await q.limit(PAGE_SIZE + 1).get()
    return {
      messages: snap.docs.slice(0, PAGE_SIZE).map((d) => {
        const m = d.data() as DocumentData
        return {
          id: d.id,
          name: String(m.name ?? ''),
          email: String(m.email ?? ''),
          topic: String(m.topic ?? ''),
          message: String(m.message ?? ''),
          createdAt: ms(m.createdAt),
          handled: m.handled === true,
          handledAt: ms(m.handledAt),
          uid: typeof m.uid === 'string' ? m.uid : null,
        }
      }),
      more: snap.size > PAGE_SIZE,
    }
  },
)

export const adminSetContactHandled = onCall({ timeoutSeconds: 20, memory: '256MiB', invoker: 'public' }, async (request): Promise<{ ok: true }> => {
  const f = (request.data ?? {}) as Record<string, unknown>
  const id = docId(f.id)
  if (!id || typeof f.handled !== 'boolean') throw new HttpsError('invalid-argument', 'id and handled required')
  const handled = f.handled
  const by = await requireAdminAudited(request.auth, { action: handled ? 'contact.handled' : 'contact.unhandled', target: id })
  const ref = db().doc(`contactMessages/${id}`)
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'No such message.')
  await ref.update(
    handled
      ? { handled: true, handledBy: by, handledAt: FieldValue.serverTimestamp() }
      : { handled: false, handledBy: FieldValue.delete(), handledAt: FieldValue.delete() },
  )
  return { ok: true }
})

export const adminDeleteContactMessage = onCall({ timeoutSeconds: 20, memory: '256MiB', invoker: 'public' }, async (request): Promise<{ ok: true }> => {
  const id = docId(((request.data ?? {}) as Record<string, unknown>).id)
  if (!id) throw new HttpsError('invalid-argument', 'id required')
  await requireAdminAudited(request.auth, { action: 'contact.delete', target: id })
  await db().doc(`contactMessages/${id}`).delete()
  return { ok: true }
})
