// Play privacy lock PIN, checked server-side (Stage B, F-050). Before this the
// PIN's hash (unsalted SHA-256 of "{uid}:{pin}") sat in the owner-readable
// users/{uid}/settings/playPin and in localStorage, with the lockout in
// localStorage too — anyone at the keyboard (signed in as the owner, which is
// the whole point of the lock) could read it and try all 10,000 PINs offline.
//
// playPins/{uid} is server-only (rules default-deny): { salt, hash
// (PBKDF2-SHA256), failedAttempts, lockedUntil, updatedAt }. Wrong guesses are
// counted here; the client never sees anything it could test offline.
// Old hashes upgrade on the first correct entry.
//
// It's a privacy lock for shared devices, not account security: the
// unlocked state lives in the tab, and the account's own session can read
// its Play data.

import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { takeRateLimit } from './rateLimits'

const ITERATIONS = 100_000
const ATTEMPTS_PER_LOCK = 5
const FIRST_LOCK_MS = 5 * 60 * 1000
const MAX_LOCK_MS = 60 * 60 * 1000
// A reset after "Forgot your PIN?" needs a fresh SMS re-sign-in.
const RECENT_AUTH_MS = 10 * 60 * 1000
const WEAK_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '1212', '1122', '1313', '2580', '6969', '1004', '2000', '2001', '1010', '0123', '9876',
])

const db = () => getFirestore()
const pinRef = (uid: string) => db().doc(`playPins/${uid}`)
const legacyRef = (uid: string) => db().doc(`users/${uid}/settings/playPin`)

function requireUid(auth: { uid: string } | undefined): string {
  if (!auth) throw new HttpsError('unauthenticated', 'Login required')
  return auth.uid
}

function pinOf(data: unknown, field = 'pin'): string {
  const pin = (data as Record<string, unknown> | null)?.[field]
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw new HttpsError('invalid-argument', 'Enter 4 digits.')
  return pin
}

const derive = (pin: string, salt: Buffer) => pbkdf2Sync(pin, salt, ITERATIONS, 32, 'sha256')
const lockedMs = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : 0)

function newRecord(pin: string) {
  const salt = randomBytes(16)
  return { salt: salt.toString('base64'), hash: derive(pin, salt).toString('base64'), failedAttempts: 0, lockedUntil: null, updatedAt: FieldValue.serverTimestamp() }
}

export type PinCheck = { result: 'ok' } | { result: 'wrong'; attemptsLeft: number } | { result: 'locked'; lockedUntil: number }

// Checks a PIN against the stored one (upgrading an old hash), counting misses.
async function verify(uid: string, pin: string): Promise<PinCheck | null> {
  const [cur, legacy] = await Promise.all([pinRef(uid).get(), legacyRef(uid).get()])
  if (!cur.exists && !legacy.exists) return null
  return db().runTransaction(async (tx) => {
    const d = (await tx.get(pinRef(uid))).data() ?? {}
    const until = lockedMs(d.lockedUntil)
    if (until > Date.now()) return { result: 'locked', lockedUntil: until } as const
    let ok: boolean
    if (typeof d.hash === 'string' && typeof d.salt === 'string') {
      const expected = Buffer.from(d.hash, 'base64')
      const given = derive(pin, Buffer.from(d.salt, 'base64'))
      ok = expected.length === given.length && timingSafeEqual(expected, given)
    } else {
      const old: unknown = legacy.data()?.hash
      ok = typeof old === 'string' && createHash('sha256').update(`${uid}:${pin}`).digest('hex') === old
    }
    if (ok) {
      // Correct: reset the counter; an old hash becomes a salted one.
      if (typeof d.hash === 'string') tx.set(pinRef(uid), { failedAttempts: 0, lockedUntil: null }, { merge: true })
      else {
        tx.set(pinRef(uid), newRecord(pin))
        tx.delete(legacyRef(uid))
      }
      return { result: 'ok' } as const
    }
    const failed = (typeof d.failedAttempts === 'number' ? d.failedAttempts : 0) + 1
    const lockNow = failed % ATTEMPTS_PER_LOCK === 0
    const lockUntil = lockNow ? Date.now() + Math.min(MAX_LOCK_MS, FIRST_LOCK_MS * 2 ** (failed / ATTEMPTS_PER_LOCK - 1)) : null
    tx.set(pinRef(uid), { failedAttempts: failed, lockedUntil: lockUntil ? Timestamp.fromMillis(lockUntil) : null }, { merge: true })
    logger.warn('checkPlayPin: wrong PIN', { failed, locked: lockNow })
    return lockUntil ? ({ result: 'locked', lockedUntil: lockUntil } as const) : ({ result: 'wrong', attemptsLeft: ATTEMPTS_PER_LOCK - (failed % ATTEMPTS_PER_LOCK) } as const)
  })
}

export const getPlayPinStatus = onCall(
  { timeoutSeconds: 15, invoker: 'public' },
  async (request): Promise<{ hasPin: boolean; lockedUntil: number }> => {
    const uid = requireUid(request.auth)
    const [cur, legacy] = await Promise.all([pinRef(uid).get(), legacyRef(uid).get()])
    const until = lockedMs(cur.data()?.lockedUntil)
    return { hasPin: (cur.exists && typeof cur.data()?.hash === 'string') || legacy.exists, lockedUntil: until > Date.now() ? until : 0 }
  },
)

export const checkPlayPin = onCall({ timeoutSeconds: 15, invoker: 'public' }, async (request): Promise<PinCheck> => {
  const uid = requireUid(request.auth)
  const pin = pinOf(request.data)
  await takeRateLimit(uid, 'playPin', { max: 30, windowMs: 10 * 60 * 1000 })
  const r = await verify(uid, pin)
  if (!r) throw new HttpsError('not-found', 'No Play PIN set.')
  return r
})

// Sets the PIN: the first one freely; a change with the current PIN; a reset
// ("Forgot your PIN?") right after re-verifying the account's phone by SMS.
export const setPlayPin = onCall({ timeoutSeconds: 15, invoker: 'public' }, async (request): Promise<{ ok: true }> => {
  const uid = requireUid(request.auth)
  const pin = pinOf(request.data)
  if (WEAK_PINS.has(pin)) throw new HttpsError('invalid-argument', 'That PIN is too easy to guess — pick something less obvious.')
  await takeRateLimit(uid, 'playPin', { max: 30, windowMs: 10 * 60 * 1000 })
  const [cur, legacy] = await Promise.all([pinRef(uid).get(), legacyRef(uid).get()])
  if (cur.data()?.hash || legacy.exists) {
    const data = request.data as Record<string, unknown> | null
    const authTime = Number(request.auth?.token.auth_time ?? 0) * 1000
    const reset = data?.reset === true && Date.now() - authTime < RECENT_AUTH_MS
    if (!reset) {
      const r = await verify(uid, pinOf(data, 'currentPin'))
      if (r?.result !== 'ok') throw new HttpsError('permission-denied', r?.result === 'locked' ? 'Too many attempts. Try again later.' : 'Incorrect PIN')
    }
  }
  await pinRef(uid).set(newRecord(pin))
  await legacyRef(uid).delete()
  return { ok: true }
})
