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
import { fetchPublicUserDoc } from './publicUserDoc'
import { loadPlayProfileStatus } from './playProfile'
import { playNameOf } from './displayNames'

export interface MatchEntry {
  matchId: string
  partnerUid: string
  name: string
  age: number | null
  photoURL: string | null
  lastMessagePreview: string | null
  lastMessageAt: number // ms, 0 if no messages yet
  matchedAt: number // ms
  // This match's generation: when it began (matchGeneration, else the
  // earliest of matchedAt/createdAt; 0 if unknown) — the same value the
  // server derives (functions/src/matchGeneration.ts). Match ids are the
  // sorted uid pair, so a re-match reuses the id; anything in the messages
  // subcollection sent before this belongs to an earlier match, and reviews
  // are per generation.
  startedAt: number // ms
  lastSenderId: string | null
  mode: Mode
  // Blocked or unmatched; mobile's unmatch deletes the doc instead.
  ended: boolean
  // A reported chat kept read-only for its reporter until then (ms), else null.
  preservedUntil: number | null
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

// Earliest non-zero time, or 0 when there's none.
function earliest(...times: number[]): number {
  const known = times.filter((ms) => ms > 0)
  return known.length ? Math.min(...known) : 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

export function toEntry(matchId: string, data: DocumentData, uid: string): MatchEntry | null {
  // 'participants' is the legacy name for 'users'. A reported chat kept for
  // its reporter after an unmatch lists only the reporter in users; the
  // pair is in pairUsers (T&S Phase 1).
  const users: unknown = Array.isArray(data.pairUsers) ? data.pairUsers : (data.users ?? data.participants)
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
    startedAt:
      typeof data.matchGeneration === 'number' && data.matchGeneration > 0
        ? data.matchGeneration
        : earliest(toMillis(data.matchedAt), toMillis(data.createdAt)),
    lastSenderId: str(data.lastSenderId),
    mode: data.mode === 'play' ? 'play' : 'spark',
    ended: data.isBlocked === true || (data.unmatchedAt !== undefined && data.unmatchedAt !== null),
    preservedUntil: toMillis(data.preservedUntil) || null,
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
  // Filtered by mode in the query: Play matches are readable only with Play
  // access (Stage 2 rules), and a query must not reach ones it can't read.
  const q = query(collection(db, 'matches'), where('users', 'array-contains', uid), where('mode', '==', mode))
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

// Every match the user is in, across both modes — Play ones only while the
// user has Play access (the rules refuse them otherwise, and that's not an
// error here: the Play half is simply empty).
export function subscribeAllMatches(
  uid: string,
  onChange: (matches: MatchEntry[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const byMode: Partial<Record<Mode, MatchEntry[]>> = {}
  const listen = (mode: Mode) =>
    onSnapshot(
      query(collection(db, 'matches'), where('users', 'array-contains', uid), where('mode', '==', mode)),
      (snap) => {
        byMode[mode] = snap.docs.map((d) => toEntry(d.id, d.data(), uid)).filter((e): e is MatchEntry => e !== null)
        if (byMode.spark && byMode.play) onChange([...byMode.spark, ...byMode.play])
      },
      (err) => {
        if (mode === 'play' && (err as { code?: string }).code === 'permission-denied') {
          byMode.play = []
          if (byMode.spark) onChange(byMode.spark)
        } else onError(err)
      },
    )
  const offs = [listen('spark'), listen('play')]
  return () => offs.forEach((off) => off())
}

// Whether the conversation has started. The match doc's lastMessage* fields
// stand in for the messages subcollection, which would cost a read per match.
export function hasMessages(m: MatchEntry): boolean {
  return m.lastMessageAt > 0 || m.lastMessagePreview !== null
}

const NEW_MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// Matched in the last 7 days and nobody has written yet.
export function isNewMatch(m: MatchEntry, now: number): boolean {
  return !m.ended && !hasMessages(m) && m.matchedAt > now - NEW_MATCH_WINDOW_MS
}

// ─── Play identity ───────────────────────────────────────────────────────────

export interface PlayIdentity {
  name: string // '' when they have none
  photoURL: string | null
  unavailable: boolean
}

const playIdentities = new Map<string, Promise<PlayIdentity>>()

// Someone's Play name and first Play photo, for Play lists built from
// snapshots that may carry Spark data (older match snapshots, like-queue
// entries). Never the Spark photo; the name falls back as playNameOf does.
// Cached for the session.
export function loadPlayIdentity(uid: string): Promise<PlayIdentity> {
  let request = playIdentities.get(uid)
  if (!request) {
    request = Promise.all([fetchPublicUserDoc(uid), loadPlayProfileStatus(uid)]).then(([root, { play, denied }]) => ({
      name: playNameOf(play, root),
      photoURL: play?.photoURLs[0] ?? null,
      // Their Play profile can't be read: they (or you) don't have Play
      // access right now — shown as unavailable, not as an error.
      unavailable: denied,
    }))
    playIdentities.set(uid, request)
    // Don't keep an "unavailable" answer: access can come back this session.
    void request.then((r) => r.unavailable && playIdentities.delete(uid))
  }
  return request
}
