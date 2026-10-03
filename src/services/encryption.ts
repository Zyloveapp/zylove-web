import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'

// X25519 + XSalsa20-Poly1305 (nacl.box). Messages are stored in the same
// { ciphertext, nonce } shape the mobile app uses; nonces of 'stub' /
// 'stub-nonce' / 'system' mark plaintext (bots, legacy mobile, system notes).

const PLAINTEXT_NONCES = new Set(['stub', 'stub-nonce', 'system'])

export function isPlaintextNonce(nonce: string): boolean {
  return PLAINTEXT_NONCES.has(nonce)
}

function decodeKey(b64: string | null | undefined, expectedLength: number): Uint8Array | null {
  if (!b64) return null
  try {
    const bytes = naclUtil.decodeBase64(b64)
    return bytes.length === expectedLength ? bytes : null
  } catch {
    return null
  }
}

// True only for a decodable 32-byte X25519 public key. Stub values written by
// the mobile app ('stub-public-key') and seeded bots ('seed-stub-key') fail.
export function isRealPublicKey(b64: string | null | undefined): b64 is string {
  return decodeKey(b64, nacl.box.publicKeyLength) !== null
}

export function encryptMessage(
  plaintext: string,
  recipientPublicKeyB64: string,
  senderPrivateKeyB64: string,
): { ciphertext: string; nonce: string } {
  const recipientPublicKey = decodeKey(recipientPublicKeyB64, nacl.box.publicKeyLength)
  const senderPrivateKey = decodeKey(senderPrivateKeyB64, nacl.box.secretKeyLength)
  if (!recipientPublicKey || !senderPrivateKey) return { ciphertext: plaintext, nonce: 'stub' }

  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const encrypted = nacl.box(naclUtil.decodeUTF8(plaintext), nonce, recipientPublicKey, senderPrivateKey)
  return { ciphertext: naclUtil.encodeBase64(encrypted), nonce: naclUtil.encodeBase64(nonce) }
}

// Returns null when the message can't be decrypted (missing/wrong keys,
// tampered ciphertext). nacl.box is symmetric in the key pair, so the sender
// decrypts their own messages with (partner public key, own private key).
export function decryptMessage(
  ciphertext: string,
  nonce: string,
  senderPublicKeyB64: string,
  recipientPrivateKeyB64: string,
): string | null {
  if (isPlaintextNonce(nonce)) return ciphertext

  const senderPublicKey = decodeKey(senderPublicKeyB64, nacl.box.publicKeyLength)
  const recipientPrivateKey = decodeKey(recipientPrivateKeyB64, nacl.box.secretKeyLength)
  const nonceBytes = decodeKey(nonce, nacl.box.nonceLength)
  if (!senderPublicKey || !recipientPrivateKey || !nonceBytes) return null

  try {
    const opened = nacl.box.open(naclUtil.decodeBase64(ciphertext), nonceBytes, senderPublicKey, recipientPrivateKey)
    return opened ? naclUtil.encodeUTF8(opened) : null
  } catch {
    return null
  }
}

// ─── Photos ──────────────────────────────────────────────────────────────────
// Each photo gets its own random 32-byte key. The photo bytes are sealed with
// nacl.secretbox under that key, and the key itself is wrapped with nacl.box
// twice: once for the recipient and once for the sender (box to their own
// public key), so both can open it. Storage only ever holds ciphertext.

export interface EncryptedPhoto {
  encryptedPhoto: Uint8Array
  photoNonce: string // base64
  encryptedKeyForSender: string // base64
  encryptedKeyForRecipient: string // base64
  keyNonceForSender: string // base64
  keyNonceForRecipient: string // base64
}

// Keys are the same base64 strings the message functions take. Throws if any
// key is missing or malformed — a photo is never sent unencrypted.
export function encryptPhoto(
  photoBytes: Uint8Array,
  senderPrivateKeyB64: string,
  senderPublicKeyB64: string,
  recipientPublicKeyB64: string,
): EncryptedPhoto {
  const senderPrivateKey = decodeKey(senderPrivateKeyB64, nacl.box.secretKeyLength)
  const senderPublicKey = decodeKey(senderPublicKeyB64, nacl.box.publicKeyLength)
  const recipientPublicKey = decodeKey(recipientPublicKeyB64, nacl.box.publicKeyLength)
  if (!senderPrivateKey || !senderPublicKey || !recipientPublicKey) throw new Error(ENCRYPTION_KEYS_UNAVAILABLE)

  const symmetricKey = nacl.randomBytes(nacl.secretbox.keyLength)
  const photoNonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const nonceA = nacl.randomBytes(nacl.box.nonceLength)
  const nonceB = nacl.randomBytes(nacl.box.nonceLength)
  const result: EncryptedPhoto = {
    encryptedPhoto: nacl.secretbox(photoBytes, photoNonce, symmetricKey),
    photoNonce: naclUtil.encodeBase64(photoNonce),
    encryptedKeyForSender: naclUtil.encodeBase64(nacl.box(symmetricKey, nonceA, senderPublicKey, senderPrivateKey)),
    encryptedKeyForRecipient: naclUtil.encodeBase64(nacl.box(symmetricKey, nonceB, recipientPublicKey, senderPrivateKey)),
    keyNonceForSender: naclUtil.encodeBase64(nonceA),
    keyNonceForRecipient: naclUtil.encodeBase64(nonceB),
  }
  symmetricKey.fill(0)
  return result
}

export const ENCRYPTION_KEYS_UNAVAILABLE = 'encryption_keys_unavailable'

// senderPublicKeyB64 is the photo sender's key — the viewer's own key when
// they're looking at a photo they sent. Null on any failure.
export function decryptPhoto(
  encryptedPhoto: Uint8Array,
  photoNonceB64: string,
  encryptedKeyB64: string,
  keyNonceB64: string,
  myPrivateKeyB64: string,
  senderPublicKeyB64: string,
): Uint8Array | null {
  const myPrivateKey = decodeKey(myPrivateKeyB64, nacl.box.secretKeyLength)
  const senderPublicKey = decodeKey(senderPublicKeyB64, nacl.box.publicKeyLength)
  const keyNonce = decodeKey(keyNonceB64, nacl.box.nonceLength)
  const photoNonce = decodeKey(photoNonceB64, nacl.secretbox.nonceLength)
  if (!myPrivateKey || !senderPublicKey || !keyNonce || !photoNonce) return null
  try {
    const symmetricKey = nacl.box.open(naclUtil.decodeBase64(encryptedKeyB64), keyNonce, senderPublicKey, myPrivateKey)
    if (!symmetricKey || symmetricKey.length !== nacl.secretbox.keyLength) return null
    const photo = nacl.secretbox.open(encryptedPhoto, photoNonce, symmetricKey)
    symmetricKey.fill(0)
    return photo
  } catch {
    return null
  }
}
