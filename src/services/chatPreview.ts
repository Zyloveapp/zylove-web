import { collection, getDocs, limit, orderBy, query, Timestamp } from 'firebase/firestore'
import { db } from './firebase'
import { decryptMessage } from './encryption'
import { chatPrivateKey, fetchPartnerKey } from './keys'
import { matchPath } from './playId'
import { CONSENT_CODES, type ConsentCode } from './chat'
import { CONTACT_CODES, CONTACT_PREVIEWS, type ContactCode } from './contactExchange'
import { maskContact } from './contactDetect'
import type { MatchEntry } from './matches'

// Chat list previews. The match doc only ever carries a generic
// "New message" (message text never sits unencrypted outside the
// messages), so the list reads each chat's latest message and decrypts it
// here, in the browser, like the chat view does.

export interface ChatPreview {
  text: string
  fromMe: boolean
}

const PREVIEW_LENGTH = 40

const CONSENT_PREVIEWS: Record<ConsentCode, string> = {
  photo_consent_request: '📷 Asked to share photos',
  photo_consent_accepted: '📷 Photo sharing is on',
  photo_consent_declined: '📷 Photo sharing declined',
  photo_consent_paused: '📷 Photo sharing paused',
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH).trimEnd()}…` : flat
}

// One private-key read per user (and kind of chat) per session. F-062: a
// Play chat uses the Play key.
const privateKeys = new Map<string, Promise<string | null>>()
function privateKeyFor(uid: string, matchId: string): Promise<string | null> {
  const k = `${uid}:${matchId.startsWith('pm_') ? 'play' : 'spark'}`
  let key = privateKeys.get(k)
  if (!key) {
    key = chatPrivateKey(uid, matchId).catch(() => null)
    privateKeys.set(k, key)
  }
  return key
}

// Keyed by the chat's lastMessageAt, so a new message fetches afresh.
const previews = new Map<string, Promise<ChatPreview | null>>()

// The latest message as a one-line preview, or null if there isn't one (or
// it can't be read).
export function loadChatPreview(match: MatchEntry, uid: string): Promise<ChatPreview | null> {
  const cacheKey = `${uid}:${match.matchId}:${match.lastMessageAt}`
  let preview = previews.get(cacheKey)
  if (!preview) {
    preview = fetchPreview(match, uid).catch(() => null)
    previews.set(cacheKey, preview)
  }
  return preview
}

async function fetchPreview(match: MatchEntry, uid: string): Promise<ChatPreview | null> {
  const snap = await getDocs(
    query(collection(db, `${matchPath(match.matchId)}/messages`), orderBy('sentAt', 'desc'), limit(1)),
  )
  const data = snap.docs[0]?.data()
  if (!data) return null
  // Left over from an earlier match between the same two people.
  const sentAt: unknown = data.sentAt
  if (sentAt instanceof Timestamp && sentAt.toMillis() < match.startedAt) return null
  const fromMe = data.senderId === match.selfId
  const messageType = typeof data.messageType === 'string' ? data.messageType : 'text'
  const ciphertext = typeof data.ciphertext === 'string' ? data.ciphertext : ''

  if (messageType === 'photo') return { text: '📷 Photo', fromMe }
  // T&S Phase 3: a card never shows in the list, and nor do contact details.
  if (messageType === 'contact_card') return { text: '🪪 Contact card', fromMe }
  if (messageType === 'contact_request' && (CONTACT_CODES as readonly string[]).includes(ciphertext)) {
    return { text: CONTACT_PREVIEWS[ciphertext as ContactCode], fromMe }
  }
  if (messageType === 'consent_request' && (CONSENT_CODES as readonly string[]).includes(ciphertext)) {
    return { text: CONSENT_PREVIEWS[ciphertext as ConsentCode], fromMe }
  }

  const nonce = typeof data.nonce === 'string' ? data.nonce : ''
  const [privateKey, partnerKey] = await Promise.all([privateKeyFor(uid, match.matchId), fetchPartnerKey(match.partnerUid).catch(() => '')])
  // The box key is shared, so the same keys open both sides' messages.
  const text = decryptMessage(ciphertext, nonce, partnerKey, privateKey ?? '')
  return { text: text ? truncate(fromMe ? text : maskContact(text)) : '🔒 Encrypted message', fromMe }
}
