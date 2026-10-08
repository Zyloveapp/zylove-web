import { deleteDoc, doc, onSnapshot, serverTimestamp, setDoc, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'
import { matchPath } from './playId'

// Typing status lives at matches/{matchId}/typing/{uid}: present while that
// user is typing, deleted when they stop, send, or leave the chat. F-062: in
// a Play match, playMatches/{id}/typing/{playId} — ids are as the match names
// people (pass your selfId / the partner's id).

export async function setTyping(matchId: string, selfId: string): Promise<void> {
  await setDoc(doc(db, `${matchPath(matchId)}/typing/${selfId}`), { typingAt: serverTimestamp(), uid: selfId })
}

export async function clearTyping(matchId: string, selfId: string): Promise<void> {
  await deleteDoc(doc(db, `${matchPath(matchId)}/typing/${selfId}`))
}

// Calls back with when the partner last typed (ms), or null when not typing.
export function subscribeTyping(matchId: string, partnerUid: string, onChange: (typingAt: number | null) => void): Unsubscribe {
  return onSnapshot(
    doc(db, `${matchPath(matchId)}/typing/${partnerUid}`),
    (snap) => {
      const at: unknown = snap.data()?.typingAt
      const ms =
        typeof at === 'object' && at !== null && 'toMillis' in at && typeof at.toMillis === 'function'
          ? (at.toMillis() as number)
          : null
      onChange(ms)
    },
    () => onChange(null),
  )
}
