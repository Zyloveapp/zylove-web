import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'
import { doc, getDoc, onSnapshot, updateDoc, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'
import { isRealPublicKey } from './encryption'

// Private keys live only in this browser's IndexedDB — never Firestore,
// never localStorage. Only the public key is published on users/{uid}.

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

function publicKeyFor(privateKeyB64: string): string | null {
  try {
    const secret = naclUtil.decodeBase64(privateKeyB64)
    if (secret.length !== nacl.box.secretKeyLength) return null
    return naclUtil.encodeBase64(nacl.box.keyPair.fromSecretKey(secret).publicKey)
  } catch {
    return null
  }
}

// Resolves this browser's keypair without touching Firestore. Reuses the
// stored private key when there is one (so message history stays readable),
// otherwise generates and stores a new one. `changed` means the published key
// on users/{uid} needs updating.
export async function resolveKeypair(
  uid: string,
  existingPublicKey?: string,
): Promise<{ publicKey: string; changed: boolean }> {
  const stored = await getPrivateKey(uid)
  const derived = stored ? publicKeyFor(stored) : null
  if (derived) return { publicKey: derived, changed: derived !== existingPublicKey }

  const { publicKey, privateKey } = generateKeypair()
  await storePrivateKey(uid, privateKey)
  return { publicKey, changed: true }
}

export async function getOrCreateKeypair(uid: string, existingPublicKey?: string): Promise<{ publicKey: string }> {
  const { publicKey, changed } = await resolveKeypair(uid, existingPublicKey)
  if (changed) await updateDoc(doc(db, 'users', uid), { publicKey })
  return { publicKey }
}

const pending = new Map<string, Promise<void>>()

// Called once auth confirms a user. Users without a root doc yet are still in
// onboarding; their keypair is created by the onboarding save instead.
export function initKeysForUser(uid: string): Promise<void> {
  let p = pending.get(uid)
  if (!p) {
    p = (async () => {
      const snap = await getDoc(doc(db, 'users', uid))
      if (!snap.exists()) return
      const publicKey: unknown = snap.data().publicKey
      await getOrCreateKeypair(uid, typeof publicKey === 'string' ? publicKey : undefined)
    })()
    p.catch(() => pending.delete(uid))
    pending.set(uid, p)
  }
  return p
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
