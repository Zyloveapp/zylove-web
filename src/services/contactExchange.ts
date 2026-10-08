import { collection, doc, onSnapshot, serverTimestamp, setDoc, type Unsubscribe } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { encryptMessage, isRealPublicKey } from './encryption'
import { chatSendingKey } from './keys'
import { matchPath, selfIdIn } from './playId'

// T&S Phase 3 — "Share contact" (functions/src/contactExchange.ts). The
// state is matches/{id}.contactExchange, moved only by callables; a card is a
// contact_card message, end-to-end encrypted on this device, which the rules
// accept only while the exchange is accepted. Zylove can't read a card.

export const UNLOCK_MESSAGES = 3
export type ContactField = 'phone' | 'instagram' | 'snapchat' | 'whatsapp'
export type ContactCard = Partial<Record<ContactField, string>>
export const CONTACT_FIELDS: { id: ContactField; label: string; placeholder: string }[] = [
  { id: 'phone', label: 'Phone number', placeholder: '(512) 555-0134' },
  { id: 'instagram', label: 'Instagram', placeholder: '@yourname' },
  { id: 'snapchat', label: 'Snapchat', placeholder: '@yourname' },
  { id: 'whatsapp', label: 'WhatsApp', placeholder: '+1 512 555 0134' },
]

export interface ContactExchange {
  status: 'pending' | 'accepted' | 'declined' | 'revoked'
  requestedBy: string
  requestedAt: number
  respondedAt: number | null
  shareBack: boolean
  revokedBy: string | null
}

// The notices the server writes (messageType 'contact_request', nonce 'system').
export const CONTACT_CODES = ['contact_request', 'contact_accepted', 'contact_declined', 'contact_revoked'] as const
export type ContactCode = (typeof CONTACT_CODES)[number]
export const CONTACT_PREVIEWS: Record<ContactCode, string> = {
  contact_request: '🪪 Contact request',
  contact_accepted: '🪪 Contact request accepted',
  contact_declined: '🪪 Contact request declined',
  contact_revoked: '🪪 Contact details taken back',
}

// A field's value cleaned up, or null when it doesn't look right.
export function cleanField(field: ContactField, raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  if (field === 'phone' || field === 'whatsapp') {
    const digits = v.replace(/[^\d+]/g, '')
    const n = digits.replace(/\D/g, '')
    if (n.length === 10 && !digits.startsWith('+')) return `+1${n}`
    return /^\+?\d{8,15}$/.test(digits) ? (digits.startsWith('+') ? digits : `+${digits}`) : null
  }
  const handle = v.replace(/^@/, '')
  const ok = field === 'instagram' ? /^[A-Za-z0-9._]{1,30}$/ : /^[A-Za-z0-9._-]{3,15}$/
  return ok.test(handle) ? `@${handle}` : null
}

export function parseCard(text: string | null): ContactCard | null {
  if (!text) return null
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const card: ContactCard = {}
    for (const f of CONTACT_FIELDS) if (typeof raw[f.id] === 'string' && raw[f.id]) card[f.id] = raw[f.id] as string
    return Object.keys(card).length ? card : null
  } catch {
    return null
  }
}

export function subscribeContactExchange(matchId: string, onChange: (ce: ContactExchange | null) => void): Unsubscribe {
  return onSnapshot(
    doc(db, matchPath(matchId)),
    (snap) => {
      const c = snap.data()?.contactExchange as Record<string, unknown> | undefined
      if (!c || typeof c.status !== 'string' || typeof c.requestedBy !== 'string') return onChange(null)
      onChange({
        status: c.status as ContactExchange['status'],
        requestedBy: c.requestedBy,
        requestedAt: typeof c.requestedAt === 'number' ? c.requestedAt : 0,
        respondedAt: typeof c.respondedAt === 'number' ? c.respondedAt : null,
        shareBack: c.shareBack === true,
        revokedBy: typeof c.revokedBy === 'string' ? c.revokedBy : null,
      })
    },
    () => onChange(null),
  )
}

const call = (name: string) => (data: Record<string, unknown>) => httpsCallable(functions, name)(data)
export const requestContact = (matchId: string) => call('requestContactExchange')({ matchId })
export const respondContact = (matchId: string, accept: boolean, shareBack = false) => call('respondContactExchange')({ matchId, accept, shareBack })
export const revokeContact = (matchId: string) => call('revokeContactExchange')({ matchId })

// Encrypts the card to the partner's key — the same box as a text message.
// F-062: in a Play match, with the Play key and as your Play ID.
export async function sendContactCard(matchId: string, uid: string, card: ContactCard, partnerPublicKey: string): Promise<void> {
  const [privateKey, sender] = await Promise.all([chatSendingKey(uid, matchId), selfIdIn(uid, matchId)])
  if (!isRealPublicKey(partnerPublicKey) || !privateKey || !sender) throw new Error('encryption_key_missing')
  const { ciphertext, nonce } = encryptMessage(JSON.stringify(card), partnerPublicKey, privateKey)
  if (nonce === 'stub') throw new Error('encryption_key_missing')
  await setDoc(doc(collection(db, `${matchPath(matchId)}/messages`)), {
    ciphertext,
    nonce,
    senderId: sender,
    sentAt: serverTimestamp(),
    status: 'sent',
    messageType: 'contact_card',
  })
}

// The card the person who asked chose, kept on this device until the other
// person accepts (it goes out then — never before).
const pendingKey = (uid: string, matchId: string) => `zylove_contact_pending_${uid}_${matchId}`
const defaultsKey = (uid: string) => `zylove_contact_defaults_${uid}`
function read(key: string): ContactCard | null {
  try {
    return parseCard(localStorage.getItem(key))
  } catch {
    return null
  }
}
function write(key: string, card: ContactCard | null): void {
  try {
    if (card) localStorage.setItem(key, JSON.stringify(card))
    else localStorage.removeItem(key)
  } catch {
    // storage unavailable
  }
}
export const pendingCard = (uid: string, matchId: string) => read(pendingKey(uid, matchId))
export const setPendingCard = (uid: string, matchId: string, card: ContactCard | null) => write(pendingKey(uid, matchId), card)
// What they filled in last time, to save typing (this device only).
export const savedDefaults = (uid: string) => read(defaultsKey(uid))
export const saveDefaults = (uid: string, card: ContactCard) => write(defaultsKey(uid), card)
