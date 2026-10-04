import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// Chat key backup (functions/src/keyBackup.ts). A 4-digit PIN is stretched
// with PBKDF2-SHA256 (600k iterations, the browser's built-in WebCrypto)
// into 64 bytes: the first 32 encrypt the private chat key (nacl secretbox),
// the last 32 are the verifier the server checks before handing the
// encrypted key back. Neither the PIN nor the private key leaves the device.

const ITERATIONS = 600_000
export const PIN_LENGTH = 4

// Too easy to guess to protect anything.
const WEAK_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '1212', '1122', '1313', '2580', '6969', '1004', '2000', '2001', '1010', '0123', '9876',
])

export function pinProblem(pin: string): string | null {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) return `Enter ${PIN_LENGTH} digits.`
  if (WEAK_PINS.has(pin)) return "That PIN is too easy to guess — pick something less obvious."
  return null
}

async function derive(pin: string, salt: Uint8Array): Promise<{ key: Uint8Array; verifier: string }> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' }, material, 512),
  )
  return { key: bits.slice(0, 32), verifier: naclUtil.encodeBase64(bits.slice(32)) }
}

export interface BackupInfo {
  exists: boolean
  salt: string | null
  publicKey: string | null
  lockedUntil: number | null
  attemptsLeft: number
}

export async function getBackupInfo(): Promise<BackupInfo> {
  const { data } = await httpsCallable<void, BackupInfo>(functions, 'getKeyBackupInfo')()
  return data
}

// Encrypts this device's private key under the PIN and stores it.
export async function saveBackup(pin: string, privateKey: string, publicKey: string): Promise<void> {
  const salt = nacl.randomBytes(16)
  const { key, verifier } = await derive(pin, salt)
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const box = nacl.secretbox(naclUtil.decodeBase64(privateKey), nonce, key)
  const blob = new Uint8Array(nonce.length + box.length)
  blob.set(nonce)
  blob.set(box, nonce.length)
  await httpsCallable<{ salt: string; blob: string; verifier: string; publicKey: string }, { ok: true }>(
    functions,
    'saveKeyBackup',
  )({ salt: naclUtil.encodeBase64(salt), blob: naclUtil.encodeBase64(blob), verifier, publicKey })
}

export type RestoreResult =
  | { ok: true; privateKey: string }
  | { ok: false; reason: 'wrong_pin'; attemptsLeft: number; lockedUntil: number | null }
  | { ok: false; reason: 'locked'; lockedUntil: number }
  | { ok: false; reason: 'no_backup' | 'corrupt' }

// Asks for the encrypted key with the PIN's verifier and opens it here.
export async function restoreBackup(pin: string, info: BackupInfo): Promise<RestoreResult> {
  if (!info.exists || !info.salt) return { ok: false, reason: 'no_backup' }
  if (info.lockedUntil) return { ok: false, reason: 'locked', lockedUntil: info.lockedUntil }
  const { key, verifier } = await derive(pin, naclUtil.decodeBase64(info.salt))
  const { data } = await httpsCallable<
    { verifier: string },
    { ok: true; blob: string; publicKey: string } | { ok: false; attemptsLeft: number; lockedUntil: number | null }
  >(functions, 'restoreKeyBackup')({ verifier })
  if (!data.ok) {
    return data.lockedUntil && data.attemptsLeft === 0
      ? { ok: false, reason: 'locked', lockedUntil: data.lockedUntil }
      : { ok: false, reason: 'wrong_pin', attemptsLeft: data.attemptsLeft, lockedUntil: data.lockedUntil }
  }
  const blob = naclUtil.decodeBase64(data.blob)
  const opened = nacl.secretbox.open(blob.slice(nacl.secretbox.nonceLength), blob.slice(0, nacl.secretbox.nonceLength), key)
  return opened ? { ok: true, privateKey: naclUtil.encodeBase64(opened) } : { ok: false, reason: 'corrupt' }
}

export async function deleteBackup(): Promise<void> {
  await httpsCallable<void, { ok: true }>(functions, 'deleteKeyBackup')()
}
