import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'

// F-062 — private Play IDs. In Play, everyone (you included) is known by an
// opaque Play ID, never the account id: Play cards, likes, matches, messages,
// typing, photo paths and every Play callable use Play IDs, and the server
// maps them back (functions/src/playIds.ts). Play matches live in
// playMatches/{pm_…}, apart from Spark's matches/{uidA_uidB}.

export const isPlayId = (v: unknown): v is string => typeof v === 'string' && /^p_[A-Za-z0-9]{20}$/.test(v)
export const isPlayMatchId = (v: unknown): v is string => typeof v === 'string' && /^pm_[A-Za-z0-9]{20}$/.test(v)

// Where a match lives: Play matches have their own collection.
export const matchPath = (matchId: string): string => (isPlayMatchId(matchId) ? `playMatches/${matchId}` : `matches/${matchId}`)

const mine = new Map<string, Promise<string | null>>()

// Your own Play ID (owner-only copy on private/account; created by the
// server on first use). Null without a Play profile.
export function myPlayId(uid: string): Promise<string | null> {
  let request = mine.get(uid)
  if (!request) {
    request = getDoc(doc(db, `users/${uid}/private/account`))
      .then((s) => s.data()?.playId)
      .catch(() => null)
      .then(async (id: unknown) =>
        isPlayId(id)
          ? id
          : httpsCallable<void, { playId: string }>(functions, 'getMyPlayId')()
              .then((r) => r.data.playId)
              .catch(() => null),
      )
    mine.set(uid, request)
    // A missing one may exist later (a Play profile finished this session).
    void request.then((id) => id === null && mine.delete(uid))
  }
  return request
}

// How you're named in a match: your Play ID in a Play match, else your uid.
export async function selfIdIn(uid: string, matchId: string): Promise<string> {
  return isPlayMatchId(matchId) ? ((await myPlayId(uid)) ?? '') : uid
}

export function forgetMyPlayId(): void {
  mine.clear()
}
