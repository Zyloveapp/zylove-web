import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'
import { doc, getDoc, onSnapshot, updateDoc, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'
import { isRealPublicKey } from './encryption'
import { deleteBackup, getBackupInfo, restoreBackup, saveBackup, type BackupInfo, type RestoreResult } from './keyBackup'

// Private keys live in this browser's IndexedDB — never Firestore in the
// clear, never localStorage. Only the public key is published on users/{uid};
// a PIN-encrypted copy can be backed up for other devices (keyBackup.ts).

const DB_NAME = 'zylove_keys'
const STORE = 'keys'

function storageKey(uid: string): string {
  return `zylove_pk_${uid}`
}

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const idb = await openKeyDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = idb.transaction(STORE, mode)
      const req = run(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })
  } finally {
    idb.close()
  }
}

export function generateKeypair(): { publicKey: string; privateKey: string } {
  const kp = nacl.box.keyPair()
  return { publicKey: naclUtil.encodeBase64(kp.publicKey), privateKey: naclUtil.encodeBase64(kp.secretKey) }
}

export async function storePrivateKey(uid: string, privateKey: string): Promise<void> {
  await withStore('readwrite', (s) => s.put(privateKey, storageKey(uid)))
}

export async function getPrivateKey(uid: string): Promise<string | null> {
  try {
    const value: unknown = await withStore('readonly', (s) => s.get(storageKey(uid)))
    return typeof value === 'string' && value ? value : null
  } catch {
    return null
  }
}

export function publicKeyFor(privateKeyB64: string): string | null {
  try {
    const secret = naclUtil.decodeBase64(privateKeyB64)
    if (secret.length !== nacl.box.secretKeyLength) return null
    return naclUtil.encodeBase64(nacl.box.keyPair.fromSecretKey(secret).publicKey)
  } catch {
    return null
  }
}

// Resolves this browser's keypair without touching Firestore.
//
// One keypair per account, shared by every device: once a real public key is
// published on users/{uid}, a browser never replaces it on its own (that
// used to swap keys on every device switch and make history unreadable).
// A browser whose stored key doesn't match — none yet, or a stale one —
// reports `mismatch`: it has to restore from the PIN backup (keyBackup.ts)
// or explicitly reset. Only when nothing real is published does it publish
// its own (`changed`).
export async function resolveKeypair(
  uid: string,
  existingPublicKey?: string,
): Promise<{ publicKey: string; changed: boolean; mismatch?: boolean }> {
  const stored = await getPrivateKey(uid)
  const derived = stored ? publicKeyFor(stored) : null
  if (isRealPublicKey(existingPublicKey)) {
    return derived === existingPublicKey
      ? { publicKey: existingPublicKey, changed: false }
      : { publicKey: existingPublicKey, changed: false, mismatch: true }
  }
  if (derived) return { publicKey: derived, changed: true }

  const { publicKey, privateKey } = generateKeypair()
  await storePrivateKey(uid, privateKey)
  return { publicKey, changed: true }
}

// ─── Key status (per account, this browser) ─────────────────────────────────
// ready: this browser holds the published key · needs_restore: it doesn't,
// and a PIN backup exists · locked: it doesn't, and there's no backup (only
// a reset, or setting a PIN on the device that has the key, will help) ·
// check_failed: it doesn't, and the backup couldn't be looked up — retry.
// backedUp: whether a PIN backup of the current key exists (null = unknown).

export type KeyStatus = 'unknown' | 'ready' | 'needs_restore' | 'locked' | 'check_failed'
export interface KeyState {
  status: KeyStatus
  backedUp: boolean | null
}

const states = new Map<string, KeyState>()
const listeners = new Map<string, Set<(s: KeyState) => void>>()

function setState(uid: string, next: KeyState): void {
  states.set(uid, next)
  for (const fn of listeners.get(uid) ?? []) fn(next)
}

export function keyState(uid: string): KeyState {
  return states.get(uid) ?? { status: 'unknown', backedUp: null }
}

export function subscribeKeyState(uid: string, onChange: (s: KeyState) => void): () => void {
  if (!listeners.has(uid)) listeners.set(uid, new Set())
  listeners.get(uid)!.add(onChange)
  onChange(keyState(uid))
  return () => listeners.get(uid)?.delete(onChange)
}

// Backup info, retried: a failed lookup must never look like "no backup".
async function backupInfoWithRetry(): Promise<BackupInfo | null> {
  for (const wait of [0, 1000, 3000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait))
    try {
      return await getBackupInfo()
    } catch (err) {
      console.warn('Chat backup lookup failed', err)
    }
  }
  return null
}

// Works out this browser's status. When a PIN backup exists, its key is the
// account's key (it's the one the user protected): the browser holding it
// republishes it if something replaced the published key (an old app
// version, a device that started fresh by mistake); any other browser must
// unlock with the PIN. Without a backup, the published key stands, and a
// browser that doesn't hold it is locked. Only when nothing real is
// published does a browser publish its own.
export async function checkKeyState(uid: string): Promise<KeyState> {
  const snap = await getDoc(doc(db, 'users', uid))
  if (!snap.exists()) return keyState(uid)
  const published: unknown = snap.data().publicKey
  const { publicKey, changed, mismatch } = await resolveKeypair(uid, typeof published === 'string' ? published : undefined)
  if (changed) await updateDoc(doc(db, 'users', uid), { publicKey })
  const stored = await getPrivateKey(uid)
  const mine = stored ? publicKeyFor(stored) : null

  const info = await backupInfoWithRetry()
  let next: KeyState
  if (info?.exists && info.publicKey) {
    if (mine === info.publicKey) {
      if (published !== info.publicKey) await updateDoc(doc(db, 'users', uid), { publicKey: info.publicKey })
      next = { status: 'ready', backedUp: true }
    } else {
      next = { status: 'needs_restore', backedUp: true }
    }
  } else if (!mismatch) {
    next = { status: 'ready', backedUp: info ? false : null }
  } else {
    next = { status: info ? 'locked' : 'check_failed', backedUp: info ? false : null }
  }
  setState(uid, next)
  return next
}

// The PIN backup of this browser's (current) key.
export async function backUpKeyWithPin(uid: string, pin: string): Promise<void> {
  const privateKey = await getPrivateKey(uid)
  const publicKey = privateKey ? publicKeyFor(privateKey) : null
  if (!privateKey || !publicKey) throw new Error('No chat key on this device.')
  await saveBackup(pin, privateKey, publicKey)
  setState(uid, { status: 'ready', backedUp: true })
}

// New device: unlock the account's key with the PIN. The backed-up key is
// the account's key, so it's republished if something else replaced it.
export async function restoreKeyWithPin(uid: string, pin: string): Promise<RestoreResult> {
  const info = await getBackupInfo()
  const result = await restoreBackup(pin, info)
  if (!result.ok) return result
  const publicKey = publicKeyFor(result.privateKey)
  if (!publicKey || (info.publicKey && publicKey !== info.publicKey)) return { ok: false, reason: 'corrupt' }
  await storePrivateKey(uid, result.privateKey)
  const published: unknown = (await getDoc(doc(db, 'users', uid))).data()?.publicKey
  if (published !== publicKey) await updateDoc(doc(db, 'users', uid), { publicKey })
  setState(uid, { status: 'ready', backedUp: true })
  return result
}

// "Forgot my PIN" / no backup: a new key for the account from this browser.
// Earlier encrypted messages stay unreadable; other browsers become locked
// until they restore from the new backup.
export async function resetKeyOnThisDevice(uid: string): Promise<void> {
  // The old backup goes first: left behind, it would win (checkKeyState)
  // and undo the reset on the next load.
  await deleteBackup()
  const { publicKey, privateKey } = generateKeypair()
  await storePrivateKey(uid, privateKey)
  await updateDoc(doc(db, 'users', uid), { publicKey })
  setState(uid, { status: 'ready', backedUp: false })
}

const pending = new Map<string, Promise<void>>()

// Called once auth confirms a user. Users without a root doc yet are still in
// onboarding; their keypair is created by the onboarding save instead.
export function initKeysForUser(uid: string): Promise<void> {
  let p = pending.get(uid)
  if (!p) {
    p = checkKeyState(uid).then(() => {})
    p.catch(() => pending.delete(uid))
    pending.set(uid, p)
  }
  return p
}

// The private key to encrypt with, or null while this browser is locked
// (needs_restore / locked): a stale key would produce messages the other
// person can't open, since they decrypt with the published public key.
export async function getSendingKey(uid: string): Promise<string | null> {
  await keysReady(uid)
  const { status } = keyState(uid)
  if (status === 'needs_restore' || status === 'locked' || status === 'check_failed') return null
  return getPrivateKey(uid)
}

// Resolves once any in-flight key setup for uid has finished (or failed).
export async function keysReady(uid: string): Promise<void> {
  await pending.get(uid)?.catch(() => {})
}

// Live public key of another user; '' when missing or not a real key.
export function subscribePublicKey(
  uid: string,
  onChange: (publicKey: string) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      const key: unknown = snap.data()?.publicKey
      onChange(typeof key === 'string' && isRealPublicKey(key) ? key : '')
    },
    onError,
  )
}
