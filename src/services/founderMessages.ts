import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// Founder ↔ Matthew messages (functions/src/founderMessages.ts). The thread
// lives server-side; founders and the admin both read it through callables.

export const FOUNDER_MESSAGE_MAX = 1000
export const ADMIN_SENDER_NAME = 'Matthew · Zylove Founder'

export interface FounderMessage {
  id: string
  fromUid: string
  fromName: string
  isFromAdmin: boolean
  body: string
  createdAt: number | null
  readAt: number | null
}

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

// users/{uid}.founderThreadMeta, as the founder sees it.
export interface FounderThreadMeta {
  hasUnread: boolean
  lastMessageAt: number | null
  lastMessagePreview: string
}

export function parseThreadMeta(v: unknown): FounderThreadMeta | null {
  if (typeof v !== 'object' || v === null) return null
  const m = v as Record<string, unknown>
  const at = m.lastMessageAt
  return {
    hasUnread: m.hasUnread === true,
    lastMessageAt: at && typeof at === 'object' && 'toMillis' in at && typeof at.toMillis === 'function' ? (at.toMillis() as number) : null,
    lastMessagePreview: typeof m.lastMessagePreview === 'string' ? m.lastMessagePreview : '',
  }
}

// The caller's own thread, or (admins) a founder's.
export async function getFounderThread(founderUid?: string): Promise<FounderMessage[]> {
  const { data } = await httpsCallable<{ founderUid?: string }, { messages: FounderMessage[] }>(
    functions,
    'getFounderThread',
  )(founderUid ? { founderUid } : {})
  return data.messages
}

export async function sendFounderMessage(body: string): Promise<void> {
  await httpsCallable(functions, 'sendFounderMessage')({ body })
}

export async function markFounderThreadRead(): Promise<void> {
  await httpsCallable(functions, 'markFounderThreadRead')({})
}

export async function getFounderThreads(): Promise<{ threads: FounderThreadSummary[]; founderCount: number }> {
  const { data } = await httpsCallable<object, { threads: FounderThreadSummary[]; founderCount: number }>(
    functions,
    'getFounderThreads',
  )({})
  return data
}

export async function replyToFounder(founderUid: string, body: string): Promise<void> {
  await httpsCallable(functions, 'replyToFounder')({ founderUid, body })
}

export async function broadcastToFounders(
  body: string,
): Promise<{ sent: number; failed: number; texted: number; total: number }> {
  const { data } = await httpsCallable<{ body: string }, { sent: number; failed: number; texted: number; total: number }>(
    functions,
    'broadcastToFounders',
    { timeout: 300_000 },
  )({ body })
  return data
}

// "3m", "2h", "5d" since a time; "" when unknown.
export function timeSince(ms: number | null, now = Date.now()): string {
  if (ms === null) return ''
  const mins = Math.max(0, Math.floor((now - ms) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function formatMessageTime(ms: number | null): string {
  if (ms === null) return ''
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
