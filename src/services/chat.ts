import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from './firebase'

// Message format shared with the mobile app. Messages are currently stored as
// plaintext in `ciphertext` with nonce 'stub' (mobile's encryption module is a
// stub) — field names are kept so both apps read each other's messages.
export interface ChatMessage {
  id: string
  senderId: string
  text: string
  nonce: string
  sentAt: number | null // null while the server timestamp is pending
  status: string
  messageType: string
}

// Photo-consent protocol messages written by the mobile app. Not rendered here.
const CONSENT_PREFIX = 'photo_consent'
const HIDDEN_TYPES = new Set(['consent_request'])

export const MAX_MESSAGE_LENGTH = 2000

function toMillis(v: unknown): number | null {
  if (typeof v === 'object' && v !== null && 'toMillis' in v && typeof v.toMillis === 'function') {
    const ms: unknown = v.toMillis()
    return typeof ms === 'number' ? ms : null
  }
  return typeof v === 'number' ? v : null
}

export function subscribeMessages(
  matchId: string,
  uid: string,
  onChange: (messages: ChatMessage[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const q = query(collection(db, `matches/${matchId}/messages`), orderBy('sentAt', 'asc'))
  return onSnapshot(
    q,
    { includeMetadataChanges: false },
    (snap) => {
      const messages: ChatMessage[] = []
      for (const d of snap.docs) {
        const data = d.data()
        const deletedFor: unknown = data.deletedFor
        if (Array.isArray(deletedFor) && deletedFor.includes(uid)) continue
        const text = typeof data.ciphertext === 'string' ? data.ciphertext : ''
        const messageType = typeof data.messageType === 'string' ? data.messageType : 'text'
        if (text.startsWith(CONSENT_PREFIX) || HIDDEN_TYPES.has(messageType)) continue
        messages.push({
          id: d.id,
          senderId: typeof data.senderId === 'string' ? data.senderId : '',
          text,
          nonce: typeof data.nonce === 'string' ? data.nonce : '',
          sentAt: toMillis(data.sentAt),
          status: typeof data.status === 'string' ? data.status : 'sent',
          messageType,
        })
      }
      onChange(messages)
    },
    onError,
  )
}

export async function sendMessage(matchId: string, uid: string, text: string): Promise<void> {
  await addDoc(collection(db, `matches/${matchId}/messages`), {
    ciphertext: text,
    nonce: 'stub',
    senderId: uid,
    sentAt: serverTimestamp(),
    status: 'sent',
    messageType: 'text',
  })
  // Same fields the mobile chat updates; lastSenderId drives unread state.
  await updateDoc(doc(db, 'matches', matchId), {
    lastMessagePreview: text,
    lastMessageAt: serverTimestamp(),
    lastSenderId: uid,
    hasUnread: true,
  })
}

// Read receipts: the mobile app marks received messages 'read' when the chat
// is open, which is what shows ✓✓ to the sender.
export async function markMessagesRead(matchId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return
  const batch = writeBatch(db)
  for (const id of messageIds.slice(0, 450)) {
    batch.update(doc(db, `matches/${matchId}/messages/${id}`), { status: 'read' })
  }
  await batch.commit()
}
