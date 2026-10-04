import { addDoc, collection, doc, getDoc, onSnapshot, serverTimestamp, updateDoc, type Unsubscribe } from 'firebase/firestore'
import { getBytes, ref, uploadBytes } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { db, functions, storage } from './firebase'
import { ENCRYPTION_KEYS_UNAVAILABLE, decryptPhoto, encryptPhoto, isRealPublicKey } from './encryption'
import { getPrivateKey, keysReady, publicKeyFor } from './keys'
import type { ConsentCode, PhotoPayload } from './chat'

// ─── Consent ─────────────────────────────────────────────────────────────────
// Same shape as mobile: matches/{matchId}.photoConsent, plus a system message
// in the chat for every change so both people see it happen.

export type PhotoConsentStatus = 'pending' | 'accepted' | 'declined' | 'paused'

export interface PhotoConsent {
  status: PhotoConsentStatus
  requestedBy: string
  requestedAt: number
}

const STATUSES: readonly PhotoConsentStatus[] = ['pending', 'accepted', 'declined', 'paused']

// Live, and re-subscribes after an error (a dropped listener would otherwise
// leave a new request unanswerable until a reload).
export function subscribePhotoConsent(matchId: string, onChange: (consent: PhotoConsent | null) => void): Unsubscribe {
  let unsub: Unsubscribe = () => {}
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const listen = () => {
    unsub = listenPhotoConsent(matchId, onChange, () => {
      if (!stopped) retry = setTimeout(listen, 3000)
    })
  }
  listen()
  return () => {
    stopped = true
    clearTimeout(retry)
    unsub()
  }
}

function listenPhotoConsent(
  matchId: string,
  onChange: (consent: PhotoConsent | null) => void,
  onError: () => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, 'matches', matchId),
    (snap) => {
      const c: unknown = snap.data()?.photoConsent
      if (typeof c !== 'object' || c === null) return onChange(null)
      const { status, requestedBy, requestedAt } = c as Record<string, unknown>
      onChange(
        STATUSES.includes(status as PhotoConsentStatus)
          ? {
              status: status as PhotoConsentStatus,
              requestedBy: typeof requestedBy === 'string' ? requestedBy : '',
              requestedAt: typeof requestedAt === 'number' ? requestedAt : 0,
            }
          : null,
      )
    },
    onError,
  )
}

async function consentMessage(matchId: string, uid: string, code: ConsentCode): Promise<void> {
  await addDoc(collection(db, `matches/${matchId}/messages`), {
    senderId: uid,
    messageType: 'consent_request',
    ciphertext: code,
    nonce: 'system',
    sentAt: serverTimestamp(),
    status: 'sent',
  })
}

export async function requestPhotoConsent(matchId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, 'matches', matchId), {
    photoConsent: { requestedBy: uid, requestedAt: Date.now(), status: 'pending' },
  })
  await consentMessage(matchId, uid, 'photo_consent_request')
}

// Accepting goes through the acceptPhotoConsent callable — Firestore rules
// refuse a client setting 'accepted'. Declining is a plain write.
export async function respondToPhotoConsent(matchId: string, uid: string, accept: boolean): Promise<void> {
  if (accept) {
    await httpsCallable<{ matchId: string }, { success: true }>(functions, 'acceptPhotoConsent')({ matchId })
    return
  }
  await updateDoc(doc(db, 'matches', matchId), { 'photoConsent.status': 'declined' })
  await consentMessage(matchId, uid, 'photo_consent_declined')
}

export async function pausePhotoSharing(matchId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, 'matches', matchId), { 'photoConsent.status': 'paused' })
  await consentMessage(matchId, uid, 'photo_consent_paused')
}

const bannerKey = (matchId: string) => `zylove_photo_consent_seen_${matchId}`

export function photoBannerSeen(matchId: string): boolean {
  try {
    return localStorage.getItem(bannerKey(matchId)) === '1'
  } catch {
    return false
  }
}

export function markPhotoBannerSeen(matchId: string): void {
  try {
    localStorage.setItem(bannerKey(matchId), '1')
  } catch {
    // Storage unavailable — the explainer shows again next time.
  }
}

// ─── Sending ─────────────────────────────────────────────────────────────────

export const PHOTO_TIMERS = [0, 5, 10, 30] as const
export type PhotoTimer = (typeof PHOTO_TIMERS)[number]

const MAX_EDGE = 1600
const JPEG_QUALITY = 0.85
export const PHOTO_UNREADABLE = 'photo_unreadable'

// Re-encodes through a canvas: caps the size and drops all metadata (EXIF,
// including GPS location) before anything is encrypted or uploaded.
export async function preparePhoto(file: File): Promise<Uint8Array> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(PHOTO_UNREADABLE)
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(PHOTO_UNREADABLE)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
  if (!blob) throw new Error(PHOTO_UNREADABLE)
  return new Uint8Array(await blob.arrayBuffer())
}

// Encrypts, uploads the ciphertext, then writes the message. Refuses (throws
// ENCRYPTION_KEYS_UNAVAILABLE) unless both people have real keys.
export async function sendEncryptedPhoto(
  matchId: string,
  uid: string,
  recipientUid: string,
  photoBytes: Uint8Array,
  timerSeconds: PhotoTimer,
): Promise<void> {
  await keysReady(uid)
  const privateKey = await getPrivateKey(uid)
  const senderPublicKey = privateKey ? publicKeyFor(privateKey) : null
  const recipientKey: unknown = (await getDoc(doc(db, 'users', recipientUid))).data()?.publicKey
  if (!privateKey || !senderPublicKey || typeof recipientKey !== 'string' || !isRealPublicKey(recipientKey)) {
    throw new Error(ENCRYPTION_KEYS_UNAVAILABLE)
  }

  const sealed = encryptPhoto(photoBytes, privateKey, senderPublicKey, recipientKey)
  const storagePath = `chat-photos/${matchId}/${uid}_${Date.now()}.bin`
  // The chat-photos Storage rule only accepts image/* content types, so the
  // ciphertext goes up labelled as an encrypted image.
  await uploadBytes(ref(storage, storagePath), sealed.encryptedPhoto, {
    contentType: 'image/x-zylove-encrypted',
    customMetadata: { encryption: 'nacl-secretbox' },
  })

  await addDoc(collection(db, `matches/${matchId}/messages`), {
    senderId: uid,
    messageType: 'photo',
    encrypted: true,
    storageRef: storagePath,
    photoNonce: sealed.photoNonce,
    encryptedKeyForSender: sealed.encryptedKeyForSender,
    encryptedKeyForRecipient: sealed.encryptedKeyForRecipient,
    keyNonceForSender: sealed.keyNonceForSender,
    keyNonceForRecipient: sealed.keyNonceForRecipient,
    timerSeconds,
    firstViewedAt: null,
    photoExpiresAt: null,
    destructedAt: null,
    sentAt: serverTimestamp(),
    status: 'sent',
  })
  await updateDoc(doc(db, 'matches', matchId), {
    lastMessagePreview: '📷 Photo',
    lastMessageAt: serverTimestamp(),
    lastSenderId: uid,
    hasUnread: true,
  })
}

// ─── Viewing ─────────────────────────────────────────────────────────────────

const DOWNLOAD_TIMEOUT_MS = 30_000

// Downloads and decrypts in memory; returns an object URL the caller must
// revoke. Null when it can't be opened (keys changed, file gone, tampered).
export async function openPhoto(
  photo: PhotoPayload,
  isMine: boolean,
  uid: string,
  partnerPublicKey: string,
): Promise<string | null> {
  if (!photo.storageRef) return null
  await keysReady(uid)
  const privateKey = await getPrivateKey(uid)
  if (!privateKey) return null
  const senderPublicKey = isMine ? publicKeyFor(privateKey) : partnerPublicKey
  if (!senderPublicKey) return null
  try {
    // The SDK retries a failed download for up to 2 minutes (e.g. a bucket
    // without CORS — see storage-cors.json), which looks like an endless
    // spinner; give up sooner and say it couldn't be displayed.
    const download = getBytes(ref(storage, photo.storageRef))
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('photo_download_timeout')), DOWNLOAD_TIMEOUT_MS))
    const encrypted = new Uint8Array(await Promise.race([download, timeout]))
    const bytes = decryptPhoto(
      encrypted,
      photo.photoNonce,
      isMine ? photo.encryptedKeyForSender : photo.encryptedKeyForRecipient,
      isMine ? photo.keyNonceForSender : photo.keyNonceForRecipient,
      privateKey,
      senderPublicKey,
    )
    return bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' })) : null
  } catch (err) {
    console.error('Chat photo download failed:', err)
    return null
  }
}

// Recipient's first view: starts the timer server-side.
export async function markPhotoViewed(matchId: string, messageId: string): Promise<void> {
  await httpsCallable<{ matchId: string; messageId: string }, { success: true }>(
    functions,
    'markChatPhotoViewed',
  )({ matchId, messageId })
}
