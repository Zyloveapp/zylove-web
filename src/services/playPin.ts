import { RecaptchaVerifier, reauthenticateWithPhoneNumber, type ConfirmationResult } from 'firebase/auth'
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { auth, db } from './firebase'

// Play mode PIN: a privacy lock for shared devices. Only a SHA-256 hash of
// "{uid}:{pin}" is kept — never the PIN. The hash lives in
// users/{uid}/settings/playPin (readable only by its owner), so it survives
// signing out, cleared site data, Safari's storage expiry and switching
// between the browser and the home-screen app. localStorage holds a cached
// copy so checks work offline. It hides Play from someone else at the
// keyboard; it isn't account security.

export const PIN_LENGTH = 4
const MAX_ATTEMPTS = 3
const LOCKOUT_MS = 30_000

function hashKey(uid: string): string {
  return `zylove_play_pin_${uid}`
}

function lockKey(uid: string): string {
  return `zylove_play_pin_lock_${uid}`
}

async function hashPin(uid: string, pin: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${uid}:${pin}`))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage unavailable — the PIN can't persist in this browser.
  }
}

const remoteRef = (uid: string) => doc(db, `users/${uid}/settings/playPin`)

// From the cache: accurate once loadPin has run for this user.
export function hasPin(uid: string): boolean {
  return read(hashKey(uid)) !== null
}

// Syncs the cache with Firestore and resolves whether a PIN is set. A PIN
// only this browser knows (set before PINs were stored remotely) is uploaded.
// If Firestore can't be reached, the cache answers.
export async function loadPin(uid: string): Promise<boolean> {
  if (!uid) return false
  const local = read(hashKey(uid))
  try {
    const remote: unknown = (await getDoc(remoteRef(uid))).data()?.hash
    if (typeof remote === 'string' && remote) {
      write(hashKey(uid), remote)
      return true
    }
    if (local) await setDoc(remoteRef(uid), { hash: local, updatedAt: serverTimestamp() })
  } catch {
    // Offline or unreadable — fall back to the cache.
  }
  return local !== null
}

export async function savePin(uid: string, pin: string): Promise<void> {
  const hash = await hashPin(uid, pin)
  write(hashKey(uid), hash)
  write(lockKey(uid), null)
  await setDoc(remoteRef(uid), { hash, updatedAt: serverTimestamp() })
}

export async function clearPin(uid: string): Promise<void> {
  write(hashKey(uid), null)
  write(lockKey(uid), null)
  await deleteDoc(remoteRef(uid))
}

// ─── Attempts ────────────────────────────────────────────────────────────────
// Kept in localStorage so a reload doesn't reset the lockout.

interface LockState {
  fails: number
  until: number // epoch ms; 0 when not locked
}

function readLock(uid: string): LockState {
  try {
    const parsed: unknown = JSON.parse(read(lockKey(uid)) ?? '{}')
    const s = parsed as Partial<LockState>
    return { fails: typeof s.fails === 'number' ? s.fails : 0, until: typeof s.until === 'number' ? s.until : 0 }
  } catch {
    return { fails: 0, until: 0 }
  }
}

// Epoch ms the lockout ends, or 0 when entry is allowed.
export function lockedUntil(uid: string): number {
  const { until } = readLock(uid)
  return until > Date.now() ? until : 0
}

export type PinCheck = 'ok' | 'wrong' | 'locked'

export async function checkPin(uid: string, pin: string): Promise<PinCheck> {
  if (lockedUntil(uid)) return 'locked'
  if ((await hashPin(uid, pin)) === read(hashKey(uid))) {
    write(lockKey(uid), null)
    return 'ok'
  }
  const fails = readLock(uid).fails + 1
  const locked = fails >= MAX_ATTEMPTS
  write(lockKey(uid), JSON.stringify(locked ? { fails: 0, until: Date.now() + LOCKOUT_MS } : { fails, until: 0 }))
  return locked ? 'locked' : 'wrong'
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
