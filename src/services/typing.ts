import { deleteDoc, doc, onSnapshot, serverTimestamp, setDoc, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'

// Typing status lives at matches/{matchId}/typing/{uid}: present while that
// user is typing, deleted when they stop, send, or leave the chat.

export async function setTyping(matchId: string, uid: string): Promise<void> {
  await setDoc(doc(db, `matches/${matchId}/typing/${uid}`), { typingAt: serverTimestamp(), uid })
}

export async function clearTyping(matchId: string, uid: string): Promise<void> {
  await deleteDoc(doc(db, `matches/${matchId}/typing/${uid}`))
}

// Calls back with when the partner last typed (ms), or null when not typing.
export function subscribeTyping(matchId: string, partnerUid: string, onChange: (typingAt: number | null) => void): Unsubscribe {
  return onSnapshot(
    doc(db, `matches/${matchId}/typing/${partnerUid}`),
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
