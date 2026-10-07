import { RecaptchaVerifier, reauthenticateWithPhoneNumber, type ConfirmationResult } from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'
import { auth, functions } from './firebase'

// Play mode PIN: a privacy lock for shared devices. Checked server-side
// (functions/src/playPin.ts, Stage B): the server keeps a salted hash and
// counts wrong guesses, so nothing on this device can be used to guess the
// PIN offline. The browser keeps nothing about the PIN — only, in memory,
// whether one is set. It hides Play from someone else at the keyboard; it
// isn't account security.

export const PIN_LENGTH = 4

// Left behind by builds that cached the PIN's hash and lockout here.
export function forgetLocalPinData(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('zylove_play_pin_')) localStorage.removeItem(k)
    }
  } catch {
    // ignore
  }
}
forgetLocalPinData()

const known = new Map<string, { hasPin: boolean; lockedUntil: number }>()

// Whether a PIN is set, as of the last loadPin (false until then).
export function hasPin(uid: string): boolean {
  return known.get(uid)?.hasPin === true
}

// Asks the server whether a PIN is set. Throws when it can't tell — callers
// must not treat that as "no PIN" (that would offer to set a new one).
export async function loadPin(uid: string): Promise<boolean> {
  if (!uid) return false
  const { data } = await httpsCallable<Record<string, never>, { hasPin: boolean; lockedUntil: number }>(functions, 'getPlayPinStatus')({})
  known.set(uid, data)
  return data.hasPin
}

// Epoch ms the lockout ends, or 0 when entry is allowed.
export function lockedUntil(uid: string): number {
  const until = known.get(uid)?.lockedUntil ?? 0
  return until > Date.now() ? until : 0
}

export type PinCheck = 'ok' | 'wrong' | 'locked' | 'error'

export async function checkPin(uid: string, pin: string): Promise<PinCheck> {
  try {
    const { data } = await httpsCallable<{ pin: string }, { result: 'ok' | 'wrong' | 'locked'; lockedUntil?: number }>(functions, 'checkPlayPin')({ pin })
    if (data.result === 'locked') known.set(uid, { hasPin: true, lockedUntil: data.lockedUntil ?? Date.now() + 60_000 })
    return data.result
  } catch {
    return 'error'
  }
}

// Sets the PIN: the first one; a change (with the current PIN); or a reset
// right after the SMS re-verification. Throws with a message for the user.
export async function savePin(uid: string, pin: string, opts: { currentPin?: string; reset?: boolean } = {}): Promise<void> {
  try {
    await httpsCallable(functions, 'setPlayPin')({ pin, ...opts })
    known.set(uid, { hasPin: true, lockedUntil: 0 })
  } catch (err) {
    throw new Error(err instanceof FirebaseError && err.message ? err.message : "Couldn't save your PIN. Try again.")
  }
}

// ─── Reset by SMS ────────────────────────────────────────────────────────────
// Re-verifies the signed-in user's own phone number. Reauthentication rather
// than a fresh sign-in, so the session can't switch to another account.

export function accountPhone(): string | null {
  return auth.currentUser?.phoneNumber ?? null
}

export function maskPhone(phone: string): string {
  return phone.length > 4 ? `•••• ${phone.slice(-4)}` : phone
}

export function sendResetCode(container: HTMLElement): { verifier: RecaptchaVerifier; result: Promise<ConfirmationResult> } {
  const user = auth.currentUser
  const phone = accountPhone()
  if (!user || !phone) throw new Error('No phone number on this account')
  const verifier = new RecaptchaVerifier(auth, container, { size: 'invisible' })
  return { verifier, result: reauthenticateWithPhoneNumber(user, phone, verifier) }
}
