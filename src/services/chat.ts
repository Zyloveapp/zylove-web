import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from './firebase'
import { encryptMessage, isRealPublicKey } from './encryption'
import { isBotUid } from './zyloveScore'
import { getSendingKey } from './keys'

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
// The partner has no usable public key (Stage B, F-051): nothing is sent —
// plaintext goes only to bots.
export const RECIPIENT_NO_KEY = 'recipient_no_key'

// Encrypts to the recipient's public key. Plaintext (nonce 'stub') goes only
// to bots (by uid); a person without a usable key gets nothing until they
// have one (RECIPIENT_NO_KEY) — they could otherwise force plaintext by
// breaking their own key. If the recipient has a real key but we can't encrypt (own private key
// missing or unreadable), the send is refused rather than leaking plaintext.
//
// Resolves once the message is written locally — it shows in the thread at
// once, as "Sending…" — without waiting for the server, so a send while
// offline doesn't hang. `delivered` settles when the server accepts or
// rejects the message. Without offline persistence a queued write lives only
// in this tab's memory: it goes out on reconnect if the tab stays open.
export async function sendMessage(
  matchId: string,
  uid: string,
  text: string,
  recipientPublicKey: string,
  recipientUid: string,
  // On-device hash of a first message (openerHash.ts); never the text.
  openerHashHex: string | null = null,
): Promise<{ delivered: Promise<void> }> {
  const recipientHasKey = isRealPublicKey(recipientPublicKey)
  if (!recipientHasKey && !isBotUid(recipientUid)) throw new Error(RECIPIENT_NO_KEY)
  const privateKey = await getSendingKey(uid)
  if (recipientHasKey && !privateKey) throw new Error(ENCRYPTION_KEY_MISSING)
  const { ciphertext, nonce } =
    recipientHasKey && privateKey ? encryptMessage(text, recipientPublicKey, privateKey) : { ciphertext: text, nonce: 'stub' }
  // encryptMessage falls back to 'stub' if the stored private key is corrupt.
  if (recipientHasKey && nonce === 'stub') throw new Error(ENCRYPTION_KEY_MISSING)
  const delivered = setDoc(doc(collection(db, `matches/${matchId}/messages`)), {
    ciphertext,
    nonce,
    senderId: uid,
    sentAt: serverTimestamp(),
    status: 'sent',
    messageType: 'text',
    ...(openerHashHex && !isBotUid(recipientUid) ? { fh: openerHashHex } : {}),
  })
  // Same fields the mobile chat updates; lastSenderId drives unread state.
  // The preview is generic so message content never sits unencrypted on the match doc.
  // Only once the message is in: if this update fails the message still
  // counts as sent (a retry would duplicate it), so it's logged, not thrown.
  void delivered.then(
    () =>
      updateDoc(doc(db, 'matches', matchId), {
        lastMessagePreview: 'New message',
        lastMessageAt: serverTimestamp(),
        lastSenderId: uid,
        hasUnread: true,
      }).catch((err: unknown) => console.warn('Message sent, but updating the match failed', err)),
    () => {}, // A rejected message reaches the caller through `delivered`.
  )
  return { delivered }
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

// The partner key this device has seen for someone, per signed-in user
// (Stage B): 'first' the first time, 'same', or 'changed' (the new key is
// remembered). Cleared on sign-out with the rest of zylove_* storage.
export function rememberPartnerKey(uid: string, partnerUid: string, key: string): 'first' | 'same' | 'changed' {
  const k = `zylove_peerkey_${uid}_${partnerUid}`
  try {
    const seen = localStorage.getItem(k)
    localStorage.setItem(k, key)
    return seen === null ? 'first' : seen === key ? 'same' : 'changed'
  } catch {
    return 'first'
  }
}
