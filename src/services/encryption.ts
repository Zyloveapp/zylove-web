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
