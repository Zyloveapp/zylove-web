import {
  collection,
  doc,
  onSnapshot,
  query,
  setDoc,
  where,
  type DocumentData,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from './firebase'
import type { Mode } from '../store/modeStore'

export interface MatchEntry {
  matchId: string
  partnerUid: string
  name: string
  age: number | null
  photoURL: string | null
  lastMessagePreview: string | null
  lastMessageAt: number // ms, 0 if no messages yet
  matchedAt: number // ms
  lastSenderId: string | null
  mode: Mode
  // Blocked or unmatched; mobile's unmatch deletes the doc instead.
  ended: boolean
}

// Firestore Timestamp, epoch ms, or missing → epoch ms.
function toMillis(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'object' && v !== null && 'toMillis' in v && typeof v.toMillis === 'function') {
    const ms: unknown = v.toMillis()
    return typeof ms === 'number' ? ms : 0
  }
  return 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

export function toEntry(matchId: string, data: DocumentData, uid: string): MatchEntry | null {
  // 'participants' is the legacy name for 'users'.
  const users: unknown = data.users ?? data.participants
  const partnerUid = Array.isArray(users) ? users.find((u): u is string => typeof u === 'string' && u !== uid) : undefined
  if (!partnerUid) return null

  const snap: Record<string, unknown> = data.participantSnapshots?.[partnerUid] ?? {}
  return {
    matchId,
    partnerUid,
    name: str(snap.displayName) ?? 'Someone',
    age: typeof snap.age === 'number' && snap.age > 0 ? snap.age : null,
    photoURL: str(snap.photoURL),
    lastMessagePreview: str(data.lastMessagePreview),
    lastMessageAt: toMillis(data.lastMessageAt),
    matchedAt: toMillis(data.matchedAt) || toMillis(data.createdAt),
    lastSenderId: str(data.lastSenderId),
    mode: data.mode === 'play' ? 'play' : 'spark',
    ended: data.isBlocked === true || (data.unmatchedAt !== undefined && data.unmatchedAt !== null),
  }
}

// Live matches for the user in the given mode, most recent activity first.
// No server-side orderBy: orderBy('lastMessageAt') would drop matches that
// lack the field (older/bot matches) and needs an index that doesn't exist.
export function subscribeMatches(
  uid: string,
  mode: Mode,
  onChange: (matches: MatchEntry[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const q = query(collection(db, 'matches'), where('users', 'array-contains', uid))
  return onSnapshot(
    q,
    (snap) => {
      const entries = snap.docs
        .map((d) => toEntry(d.id, d.data(), uid))
        .filter((e): e is MatchEntry => e !== null && e.mode === mode)
        .sort((a, b) => Math.max(b.lastMessageAt, b.matchedAt) - Math.max(a.lastMessageAt, a.matchedAt))
      onChange(entries)
    },
    onError,
  )
}

// Live map of matchId → lastReadAt (ms) from users/{uid}/matches, the same
// per-user index the mobile chat writes when a conversation is opened.
export function subscribeLastRead(uid: string, onChange: (lastRead: Map<string, number>) => void): Unsubscribe {
  return onSnapshot(
    collection(db, `users/${uid}/matches`),
    (snap) => onChange(new Map(snap.docs.map((d) => [d.id, toMillis(d.data().lastReadAt)]))),
    () => onChange(new Map()),
  )
}

export function markMatchRead(uid: string, matchId: string): Promise<void> {
  return setDoc(doc(db, `users/${uid}/matches/${matchId}`), { lastReadAt: Date.now(), matchId }, { merge: true })
}

export function isUnread(m: MatchEntry, uid: string, lastRead: Map<string, number>): boolean {
  return m.lastMessageAt > (lastRead.get(m.matchId) ?? 0) && m.lastSenderId !== uid
}

export function relativeTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  if (diff < 2 * day) return 'yesterday'
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Every match the user is in, across both modes.
export function subscribeAllMatches(
  uid: string,
  onChange: (matches: MatchEntry[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'matches'), where('users', 'array-contains', uid)),
    (snap) => onChange(snap.docs.map((d) => toEntry(d.id, d.data(), uid)).filter((e): e is MatchEntry => e !== null)),
    onError,
  )
}
