// Chat key backup (WhatsApp-style): the browser encrypts the user's private
// chat key with a key derived from a 4-digit PIN (PBKDF2, client-side) and
// stores the ciphertext here. A new device asks for the PIN, proves it with a
// second PIN-derived value (the verifier), and only then gets the ciphertext
// back to decrypt locally. The PIN and the private key never reach us.
//
// keyBackups/{uid} is server-only (rules default-deny): { salt, blob,
// verifierHash, publicKey, failedAttempts, lockedUntil, updatedAt }.
// Releasing the blob only after a verifier check, with lockouts, stops
// someone holding a stolen session from guessing PINs offline. A 4-digit
// PIN can still be brute-forced by anyone with raw database access — there's
// no hardware vault behind this — so it protects against account takeover,
// not against the operator.

import { createHash, timingSafeEqual } from 'node:crypto'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'

const ATTEMPTS_PER_LOCK = 5
const FIRST_LOCK_MS = 15 * 60 * 1000
const MAX_LOCK_MS = 24 * 60 * 60 * 1000
const B64 = /^[A-Za-z0-9+/]+={0,2}$/

function b64(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string' || v.length < min || v.length > max || !B64.test(v)) {
    throw new HttpsError('invalid-argument', `${field} is invalid`)
  }
  return v
}

const hash = (verifier: string) => createHash('sha256').update(verifier).digest()

function lockedMs(lockedUntil: unknown): number {
  return lockedUntil instanceof Timestamp ? lockedUntil.toMillis() : 0
}

function requireUid(auth: { uid: string } | undefined): string {
  if (!auth) throw new HttpsError('unauthenticated', 'Login required')
  return auth.uid
}

export interface KeyBackupInfo {
  exists: boolean
  salt: string | null
  publicKey: string | null
  lockedUntil: number | null
  attemptsLeft: number
}

// What a device needs before asking for the PIN: whether there's a backup,
// its salt, which public key it holds, and any lockout.
export const getKeyBackupInfo = onCall(
  { timeoutSeconds: 15, memory: '256MiB', invoker: 'public' },
  async (request): Promise<KeyBackupInfo> => {
    const uid = requireUid(request.auth)
    const d = (await getFirestore().doc(`keyBackups/${uid}`).get()).data()
    if (!d) return { exists: false, salt: null, publicKey: null, lockedUntil: null, attemptsLeft: ATTEMPTS_PER_LOCK }
    const until = lockedMs(d.lockedUntil)
    const failed = typeof d.failedAttempts === 'number' ? d.failedAttempts : 0
    return {
      exists: true,
      salt: typeof d.salt === 'string' ? d.salt : null,
      publicKey: typeof d.publicKey === 'string' ? d.publicKey : null,
      lockedUntil: until > Date.now() ? until : null,
      attemptsLeft: ATTEMPTS_PER_LOCK - (failed % ATTEMPTS_PER_LOCK),
    }
  },
)

// Set or replace the backup. It must be for the key currently published on
// users/{uid}, so a stale device can't overwrite a good backup.
export const saveKeyBackup = onCall(
  { timeoutSeconds: 15, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ ok: true }> => {
    const uid = requireUid(request.auth)
    const data = (request.data ?? {}) as Record<string, unknown>
    const salt = b64(data.salt, 'salt', 16, 64)
    const blob = b64(data.blob, 'blob', 40, 400)
    const verifier = b64(data.verifier, 'verifier', 40, 64)
    const publicKey = b64(data.publicKey, 'publicKey', 40, 64)
    const db = getFirestore()
    const published: unknown = (await db.doc(`users/${uid}`).get()).data()?.publicKey
    if (published !== publicKey) throw new HttpsError('failed-precondition', "This device's chat key isn't your current one.")
    await db.doc(`keyBackups/${uid}`).set({
      salt,
      blob,
      verifierHash: hash(verifier).toString('base64'),
      publicKey,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: FieldValue.serverTimestamp(),
    })
    logger.info('saveKeyBackup: saved')
    return { ok: true }
  },
)

// Hand back the encrypted key if the verifier matches. Every 5 misses in a
// row locks restores for 15 minutes, doubling each time (max 24 hours).
export const restoreKeyBackup = onCall(
  { timeoutSeconds: 15, memory: '256MiB', invoker: 'public' },
  async (
    request,
  ): Promise<{ ok: true; blob: string; publicKey: string } | { ok: false; attemptsLeft: number; lockedUntil: number | null }> => {
    const uid = requireUid(request.auth)
    const verifier = b64((request.data as Record<string, unknown> | null)?.verifier, 'verifier', 40, 64)
    const db = getFirestore()
    const ref = db.doc(`keyBackups/${uid}`)
    return db.runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data()
      if (!d || typeof d.verifierHash !== 'string' || typeof d.blob !== 'string') {
        throw new HttpsError('not-found', 'No chat backup found.')
      }
      const until = lockedMs(d.lockedUntil)
      const failed = typeof d.failedAttempts === 'number' ? d.failedAttempts : 0
      if (until > Date.now()) return { ok: false, attemptsLeft: 0, lockedUntil: until }

      const expected = Buffer.from(d.verifierHash, 'base64')
      const given = hash(verifier)
      if (expected.length === given.length && timingSafeEqual(expected, given)) {
        tx.update(ref, { failedAttempts: 0, lockedUntil: null })
        return { ok: true, blob: d.blob, publicKey: String(d.publicKey ?? '') }
      }

      const nextFailed = failed + 1
      const locks = Math.floor(nextFailed / ATTEMPTS_PER_LOCK)
      const lockNow = nextFailed % ATTEMPTS_PER_LOCK === 0
      const lockUntil = lockNow ? Date.now() + Math.min(MAX_LOCK_MS, FIRST_LOCK_MS * 2 ** (locks - 1)) : null
      tx.update(ref, { failedAttempts: nextFailed, lockedUntil: lockUntil ? Timestamp.fromMillis(lockUntil) : null })
      logger.warn('restoreKeyBackup: wrong PIN', { failed: nextFailed, locked: lockNow })
      return { ok: false, attemptsLeft: lockNow ? 0 : ATTEMPTS_PER_LOCK - (nextFailed % ATTEMPTS_PER_LOCK), lockedUntil: lockUntil }
    })
  },
)

// "Forgot my PIN" reset: the old backup is for a key that's being replaced.
export const deleteKeyBackup = onCall(
  { timeoutSeconds: 15, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ ok: true }> => {
    const uid = requireUid(request.auth)
    await getFirestore().doc(`keyBackups/${uid}`).delete()
    return { ok: true }
  },
)
