import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// T&S Phase 1 — a random id for this browser, so the server can tell when
// several accounts are used from one device (a safety signal; never shown).
// Kept in IndexedDB and localStorage, each restoring the other. The server
// stores it only as a keyed hash, for 90 days (functions/src/devices.ts).
// Private Browsing or clearing site data resets it — it's a signal, not an id.

const LS_KEY = 'zylove_device_id'
const DB_NAME = 'zylove_device'
const STORE = 'kv'

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function idb<T>(fn: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB_NAME, 1)
      open.onupgradeneeded = () => open.result.createObjectStore(STORE)
      open.onerror = () => resolve(undefined)
      open.onsuccess = () => {
        try {
          const req = fn(open.result.transaction(STORE, mode).objectStore(STORE))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      }
    } catch {
      resolve(undefined)
    }
  })
}

const valid = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v)

export async function getDeviceId(): Promise<string> {
  let fromLs: string | null = null
  try {
    fromLs = localStorage.getItem(LS_KEY)
  } catch {
    // storage blocked
  }
  const fromDb = await idb<unknown>((s) => s.get('id'), 'readonly')
  const id = valid(fromLs) ? fromLs : valid(fromDb) ? fromDb : newId()
  if (fromLs !== id) {
    try {
      localStorage.setItem(LS_KEY, id)
    } catch {
      // storage blocked
    }
  }
  if (fromDb !== id) await idb((s) => s.put(id, 'id'), 'readwrite')
  return id
}

// Once per signed-in session (per tab session).
export async function reportDevice(uid: string): Promise<void> {
  const key = `zylove_device_reported_${uid}`
  try {
    if (sessionStorage.getItem(key)) return
  } catch {
    // storage blocked: report anyway
  }
  await httpsCallable(functions, 'recordDevice')({ deviceId: await getDeviceId() })
  try {
    sessionStorage.setItem(key, '1')
  } catch {
    // ignore
  }
}
