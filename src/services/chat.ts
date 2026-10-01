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
import { encryptMessage, isRealPublicKey } from './encryption'
import { getPrivateKey, keysReady } from './keys'

// Message format shared with the mobile app. `ciphertext` holds a base64
// nacl.box payload, or plaintext when the nonce is 'stub' / 'stub-nonce' /
// 'system' (bots, the mobile app's stubbed encryption, system notes).
export interface ChatMessage {
  id: string
  senderId: string
  ciphertext: string
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
        const ciphertext = typeof data.ciphertext === 'string' ? data.ciphertext : ''
        const messageType = typeof data.messageType === 'string' ? data.messageType : 'text'
        if (ciphertext.startsWith(CONSENT_PREFIX) || HIDDEN_TYPES.has(messageType)) continue
        messages.push({
          id: d.id,
          senderId: typeof data.senderId === 'string' ? data.senderId : '',
          ciphertext,
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

export const ENCRYPTION_KEY_MISSING = 'encryption_key_missing'

// Encrypts to the recipient's public key. Plaintext (nonce 'stub') is only
// allowed when the recipient has no real key — bots and legacy mobile users.
// If the recipient has a real key but we can't encrypt (own private key
// missing or unreadable), the send is refused rather than leaking plaintext.
export async function sendMessage(
  matchId: string,
  uid: string,
  text: string,
  recipientPublicKey: string,
): Promise<void> {
  await keysReady(uid)
  const privateKey = await getPrivateKey(uid)
  const recipientHasKey = isRealPublicKey(recipientPublicKey)
  if (recipientHasKey && !privateKey) throw new Error(ENCRYPTION_KEY_MISSING)
  const { ciphertext, nonce } =
    recipientHasKey && privateKey ? encryptMessage(text, recipientPublicKey, privateKey) : { ciphertext: text, nonce: 'stub' }
  // encryptMessage falls back to 'stub' if the stored private key is corrupt.
  if (recipientHasKey && nonce === 'stub') throw new Error(ENCRYPTION_KEY_MISSING)
  await addDoc(collection(db, `matches/${matchId}/messages`), {
    ciphertext,
    nonce,
    senderId: uid,
    sentAt: serverTimestamp(),
    status: 'sent',
    messageType: 'text',
  })
  // Same fields the mobile chat updates; lastSenderId drives unread state.
  // The preview is generic so message content never sits unencrypted on the match doc.
  await updateDoc(doc(db, 'matches', matchId), {
    lastMessagePreview: 'New message',
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
