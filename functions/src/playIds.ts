import { randomBytes } from 'node:crypto'
import { HttpsError } from 'firebase-functions/v2/https'
import { getFirestore } from 'firebase-admin/firestore'

// F-062 — private Play IDs. Play and Spark used to share the account id, so
// anyone shown a Play profile could open the same person's Spark profile.
// Every account that has (or reaches) Play gets an opaque Play ID — random,
// not derived from the uid — and everything a Play user is shown carries
// Play IDs only. The mapping is server-only:
//
//   playIds/{uid}            { playId }   the account's Play ID
//   playIdOwners/{playId}    { uid }      who it belongs to
//
// Neither collection has a client rule (default deny); the rules themselves
// get() them to tell who's who, which a client can't see. The owner's own
// Play ID is mirrored to users/{uid}/private/account (owner-only), so the app
// knows which messages and likes are its own.
//
// Play matches have their own ids too (pm_…, playMatch.ts): never the uid pair.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const PLAY_ID_RE = /^p_[A-Za-z0-9]{20}$/
export const PLAY_MATCH_ID_RE = /^pm_[A-Za-z0-9]{20}$/

const db = () => getFirestore()

export function randomId(prefix: string): string {
  // 62^20 ≈ 2^119; the modulo bias of 256 % 62 is irrelevant at this length.
  const bytes = randomBytes(20)
  let s = ''
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length]
  return prefix + s
}

export const isPlayId = (v: unknown): v is string => typeof v === 'string' && PLAY_ID_RE.test(v)
export const isPlayMatchId = (v: unknown): v is string => typeof v === 'string' && PLAY_MATCH_ID_RE.test(v)

// The account's Play ID, created on first use (transaction: one per account).
export async function ensurePlayId(uid: string): Promise<string> {
  const ref = db().doc(`playIds/${uid}`)
  const playId = await db().runTransaction(async (tx) => {
    const cur: unknown = (await tx.get(ref)).get('playId')
    if (isPlayId(cur)) return cur
    const fresh = randomId('p_')
    tx.create(db().doc(`playIdOwners/${fresh}`), { uid })
    tx.set(ref, { playId: fresh, createdAt: Date.now() })
    tx.set(db().doc(`users/${uid}/private/account`), { playId: fresh }, { merge: true })
    return fresh
  })
  return playId
}

// The account's Play ID, or null if it has none yet.
export async function playIdOf(uid: string): Promise<string | null> {
  const v: unknown = (await db().doc(`playIds/${uid}`).get()).get('playId')
  return isPlayId(v) ? v : null
}

// Who a Play ID belongs to, or null.
export async function uidOfPlayId(playId: unknown): Promise<string | null> {
  if (!isPlayId(playId)) return null
  const v: unknown = (await db().doc(`playIdOwners/${playId}`).get()).get('uid')
  return typeof v === 'string' && v ? v : null
}

// A callable's Play ID argument → the account, or the same "not available"
// answer for a malformed, unknown or own ID (nothing to tell them apart).
export async function requireUidOfPlayId(playId: unknown, callerUid?: string): Promise<string> {
  const uid = await uidOfPlayId(playId)
  if (!uid || uid === callerUid) throw new HttpsError('failed-precondition', "That profile isn't available.")
  return uid
}

// F-064/F-065: a person named alongside a match → the account, only in that
// match's namespace — a Play ID with a Play match (pm_…), a uid with a Spark
// one. A uid with a Play match or a Play ID with a Spark one is null, the same
// as a stranger, so the two ids can't be tested against each other.
export async function uidNamedIn(matchId: string, id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || !id || id.includes('/')) return null
  if (isPlayMatchId(matchId) !== isPlayId(id)) return null
  return isPlayId(id) ? uidOfPlayId(id) : id
}

// The mode an id belongs to, with no match to go by: a Play ID is Play.
export const modeOfId = (id: string): 'spark' | 'play' => (isPlayId(id) ? 'play' : 'spark')

// Several uids → their Play IDs (creating any missing — a Play counterpart
// always has one, this only covers accounts from before F-062).
export async function playIdsOf(uids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all([...new Set(uids)].map(async (u) => out.set(u, await ensurePlayId(u))))
  return out
}

// Sorted pair of Play IDs — the key of playPairs (playMatch.ts).
export const playPairKey = (a: string, b: string): string => [a, b].sort().join('_')

// Account deletion: the mapping goes with the account.
export async function removePlayId(uid: string): Promise<void> {
  const playId = await playIdOf(uid)
  const batch = db().batch()
  batch.delete(db().doc(`playIds/${uid}`))
  if (playId) batch.delete(db().doc(`playIdOwners/${playId}`))
  await batch.commit()
}
