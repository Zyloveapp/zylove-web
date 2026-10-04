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
  // Set on encrypted photo messages (messageType 'photo' sent from the web).
  photo?: PhotoPayload
}

// Everything needed to fetch and open an encrypted photo, plus its timer.
// Times are ms; photoExpiresAt is set by markChatPhotoViewed on first view.
export interface PhotoPayload {
  storageRef: string | null // null once destructed
  photoNonce: string
  encryptedKeyForSender: string
  encryptedKeyForRecipient: string
  keyNonceForSender: string
  keyNonceForRecipient: string
  timerSeconds: number // 0 = no timer
  firstViewedAt: number | null
  photoExpiresAt: number | null
  destructedAt: number | null
}

// Photo-consent system messages (same format as mobile): messageType
// 'consent_request', ciphertext one of these codes, nonce 'system'.
export const CONSENT_CODES = ['photo_consent_request', 'photo_consent_accepted', 'photo_consent_declined', 'photo_consent_paused'] as const
export type ConsentCode = (typeof CONSENT_CODES)[number]

export function consentCode(m: ChatMessage): ConsentCode | null {
  return m.messageType === 'consent_request' && (CONSENT_CODES as readonly string[]).includes(m.ciphertext)
    ? (m.ciphertext as ConsentCode)
    : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parsePhoto(data: Record<string, unknown>): PhotoPayload | undefined {
  // `encrypted` stays after the sweep strips the keys, so a destroyed photo
  // still renders as one.
  if (data.messageType !== 'photo' || (data.encrypted !== true && typeof data.encryptedKeyForRecipient !== 'string')) {
    return undefined
  }
  return {
    storageRef: typeof data.storageRef === 'string' && data.storageRef ? data.storageRef : null,
    photoNonce: str(data.photoNonce),
    encryptedKeyForSender: str(data.encryptedKeyForSender),
    encryptedKeyForRecipient: str(data.encryptedKeyForRecipient),
    keyNonceForSender: str(data.keyNonceForSender),
    keyNonceForRecipient: str(data.keyNonceForRecipient),
    timerSeconds: typeof data.timerSeconds === 'number' && data.timerSeconds > 0 ? data.timerSeconds : 0,
    firstViewedAt: toMillis(data.firstViewedAt),
    photoExpiresAt: toMillis(data.photoExpiresAt),
    destructedAt: toMillis(data.destructedAt),
  }
}

export const MAX_MESSAGE_LENGTH = 2000

function toMillis(v: unknown): number | null {
  if (typeof v === 'object' && v !== null && 'toMillis' in v && typeof v.toMillis === 'function') {
    const ms: unknown = v.toMillis()
    return typeof ms === 'number' ? ms : null
  }
  return typeof v === 'number' ? v : null
}

// Messages since `since` (ms; see MatchEntry.startedAt) — earlier ones are
// left over from a previous match between the same two people. Unsent local
// writes (sentAt still null) are kept.
export function subscribeMessages(
  matchId: string,
  uid: string,
  since: number,
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
        const sentAt = toMillis(data.sentAt)
        if (sentAt !== null && sentAt < since) continue
        const ciphertext = typeof data.ciphertext === 'string' ? data.ciphertext : ''
        const messageType = typeof data.messageType === 'string' ? data.messageType : 'text'
        const photo = parsePhoto(data)
        messages.push({
          id: d.id,
          senderId: typeof data.senderId === 'string' ? data.senderId : '',
          ciphertext,
          nonce: typeof data.nonce === 'string' ? data.nonce : '',
          sentAt,
          status: typeof data.status === 'string' ? data.status : 'sent',
          messageType,
          ...(photo ? { photo } : {}),
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
