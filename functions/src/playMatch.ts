import { HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, type DocumentData, type DocumentReference, type Transaction } from 'firebase-admin/firestore'
import { isPlayMatchId, playIdsOf, playPairKey, randomId } from './playIds'

// F-062 — Play matches live apart from Spark ones, keyed and filled with
// Play IDs only (playIds.ts):
//
//   playMatches/{pm_…}         what the two people read: players [playIdA,
//                              playIdB], snapshots / lastSenderId / every
//                              per-person field by Play ID, plus the same
//                              chat state as matches/{id}. Subcollections
//                              messages (senderId = Play ID), typing/{playId},
//                              photoConsent — as under matches.
//   playMatchMembers/{pm_…}    server-only: users [uidA, uidB], pairId, and
//                              ids { uid: playId }
//   playPairs/{pA_pB}          server-only: the live Play match of two Play IDs
//                              (the rules check it for a hidden profile; onLike
//                              finds the match through it)
//
// A Spark match keeps its id (the sorted uid pair) and doc. Everything that
// works on "a match" goes through loadMatch, which says which kind it is and
// translates between the uid (internal) and the id that side is shown.

const db = () => getFirestore()

export const matchPath = (matchId: string): string => (isPlayMatchId(matchId) ? `playMatches/${matchId}` : `matches/${matchId}`)
export const matchRefOf = (matchId: string): DocumentReference => db().doc(matchPath(matchId))
export const messagesPath = (matchId: string): string => `${matchPath(matchId)}/messages`

export interface MatchCtx {
  id: string
  ref: DocumentReference
  play: boolean
  data: DocumentData
  // The two accounts (real uids — internal only).
  users: string[]
  pairId: string
  // The id a participant is known by in this match: their Play ID in Play,
  // their uid in Spark.
  idOf(uid: string): string
  // The account behind an id shown in this match (or null if not a participant).
  uidOf(id: string): string | null
  // The other participant's uid.
  otherOf(uid: string): string | null
}

function sparkCtx(id: string, ref: DocumentReference, data: DocumentData): MatchCtx {
  const raw: unknown = data.users ?? data.participants
  const users = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === 'string') : []
  return {
    id,
    ref,
    play: false,
    data,
    users,
    pairId: typeof data.pairId === 'string' ? data.pairId : [...users].sort().join('_'),
    idOf: (uid) => uid,
    uidOf: (x) => (users.includes(x) ? x : null),
    otherOf: (uid) => users.find((u) => u !== uid) ?? null,
  }
}

function playCtx(id: string, ref: DocumentReference, data: DocumentData, members: DocumentData): MatchCtx {
  const users: string[] = Array.isArray(members.users) ? members.users.filter((u: unknown): u is string => typeof u === 'string') : []
  const ids: Record<string, string> = typeof members.ids === 'object' && members.ids ? members.ids : {}
  const owners = new Map(Object.entries(ids).map(([u, p]) => [p, u]))
  return {
    id,
    ref,
    play: true,
    data,
    users,
    pairId: typeof members.pairId === 'string' ? members.pairId : [...users].sort().join('_'),
    idOf: (uid) => ids[uid] ?? '',
    uidOf: (x) => owners.get(x) ?? null,
    otherOf: (uid) => users.find((u) => u !== uid) ?? null,
  }
}

// A match's context from data already in hand (a trigger's before/after):
// the people from the server-only record for a Play match.
export async function contextOf(matchId: string, data: DocumentData): Promise<MatchCtx> {
  const ref = matchRefOf(matchId)
  if (!isPlayMatchId(matchId)) return sparkCtx(matchId, ref, data)
  const members = (await db().doc(`playMatchMembers/${matchId}`).get()).data() ?? {}
  return playCtx(matchId, ref, data, members)
}

// Any match, by id; null if there's no such match.
export async function loadMatch(matchId: unknown, tx?: Transaction): Promise<MatchCtx | null> {
  if (typeof matchId !== 'string' || !matchId || matchId.includes('/')) return null
  const ref = matchRefOf(matchId)
  const snap = tx ? await tx.get(ref) : await ref.get()
  if (!snap.exists) return null
  if (!isPlayMatchId(matchId)) return sparkCtx(matchId, ref, snap.data() ?? {})
  const membersRef = db().doc(`playMatchMembers/${matchId}`)
  const members = tx ? await tx.get(membersRef) : await membersRef.get()
  return playCtx(matchId, ref, snap.data() ?? {}, members.data() ?? {})
}

// The match, with the caller one of its two people (else permission-denied).
export async function requireParticipant(matchId: unknown, callerUid: string): Promise<MatchCtx> {
  const ctx = await loadMatch(matchId)
  if (!ctx || !ctx.users.includes(callerUid)) throw new HttpsError('permission-denied', 'Not a participant in this match')
  return ctx
}

// As requireParticipant, and `otherId` (as the caller was shown it: a uid in
// Spark, a Play ID in Play) is the other participant. Returns their uid too.
export async function requireMatchWith(matchId: unknown, callerUid: string, otherId: unknown): Promise<{ ctx: MatchCtx; other: string }> {
  const ctx = await requireParticipant(matchId, callerUid)
  const other = typeof otherId === 'string' ? ctx.uidOf(otherId) : null
  if (!other || other === callerUid) throw new HttpsError('permission-denied', 'Not a participant in this match')
  return { ctx, other }
}

// The live Play match between two accounts, if any.
export async function livePlayMatchOf(a: string, b: string): Promise<string | null> {
  const ids = await playIdsOf([a, b])
  const v: unknown = (await db().doc(`playPairs/${playPairKey(ids.get(a)!, ids.get(b)!)}`).get()).get('matchId')
  return isPlayMatchId(v) ? v : null
}

export interface NewPlayMatch {
  users: [string, string]
  pairId: string
  // Fields of the playMatches doc besides players / mode / matchId — every
  // per-person value already keyed by Play ID.
  fields: (ids: Map<string, string>) => DocumentData
}

// Creates a Play match (new id) and its server-only records, unless the two
// already have a live one — returns [matchId, created].
export async function createPlayMatch(m: NewPlayMatch): Promise<[string, boolean]> {
  const ids = await playIdsOf(m.users)
  const [a, b] = m.users
  const pairRef = db().doc(`playPairs/${playPairKey(ids.get(a)!, ids.get(b)!)}`)
  return db().runTransaction(async (tx) => {
    const existing: unknown = (await tx.get(pairRef)).get('matchId')
    if (isPlayMatchId(existing)) {
      const cur = await tx.get(matchRefOf(existing))
      const d = cur.data()
      if (cur.exists && d?.isBlocked !== true && !d?.unmatchedAt) return [existing, false] as [string, boolean]
    }
    const matchId = randomId('pm_')
    const players = [ids.get(a)!, ids.get(b)!].sort()
    tx.create(matchRefOf(matchId), { ...m.fields(ids), matchId, players, mode: 'play' })
    tx.create(db().doc(`playMatchMembers/${matchId}`), {
      users: [...m.users].sort(),
      pairId: m.pairId,
      ids: Object.fromEntries(m.users.map((u) => [u, ids.get(u)!])),
    })
    tx.set(pairRef, { matchId })
    return [matchId, true] as [string, boolean]
  })
}

// The match has ended (unmatch, block): the two are no longer "matched" for
// the rules (a hidden profile) or for onLike.
export async function endPlayPair(ctx: MatchCtx): Promise<void> {
  if (!ctx.play || ctx.users.length !== 2) return
  const ref = db().doc(`playPairs/${playPairKey(ctx.idOf(ctx.users[0]), ctx.idOf(ctx.users[1]))}`)
  const cur: unknown = (await ref.get()).get('matchId')
  if (cur === ctx.id) await ref.delete()
}

// Every Play match an account is in (deletion, lapse lists): ids of the
// server-only records (by uid).
export async function playMatchIdsOf(uid: string): Promise<string[]> {
  const snap = await db().collection('playMatchMembers').where('users', 'array-contains', uid).select().get()
  return snap.docs.map((d) => d.id)
}
