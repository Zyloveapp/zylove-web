import { httpsCallable } from 'firebase/functions'
import { auth, functions } from './firebase'

// Profile photos are stored as Storage paths ("photos/{uid}/{mode}/{file}");
// only their owner and admins can read the files. To show one, the app asks
// the server (getPhotoUrls) for a short-lived signed URL — given only for
// photos the viewer may see (functions/src/photoAccess.ts).
//
// Lookups made in the same tick go together (up to 100 per call). URLs are
// cached until shortly before they expire. Anything that isn't a photo path
// (a bot's public URL, a blob: preview of a new upload, an older stored URL)
// is shown as it is.

const BATCH = 100
// Refresh this long before the server's expiry.
const MARGIN_MS = 5 * 60 * 1000

export function isPhotoRef(v: unknown): v is string {
  return typeof v === 'string' && /^photos\/[^/]+\/(spark|play)\/[^/]+$/.test(v)
}

const cache = new Map<string, { url: string | null; until: number }>()
let cacheOwner: string | null = null
let queued = new Map<string, ((url: string | null) => void)[]>()
let scheduled = false

function ownerCheck() {
  const viewer = auth.currentUser?.uid ?? null
  if (viewer !== cacheOwner) {
    cache.clear()
    cacheOwner = viewer
  }
}

async function flush() {
  scheduled = false
  const batch = queued
  queued = new Map()
  const refs = [...batch.keys()]
  for (let i = 0; i < refs.length; i += BATCH) {
    const chunk = refs.slice(i, i + BATCH)
    let urls: Record<string, string> = {}
    let until = Date.now() + 60_000 // failures retry after a minute
    try {
      const res = await httpsCallable<{ refs: string[] }, { urls: Record<string, string>; expiresAt: number }>(
        functions,
        'getPhotoUrls',
      )({ refs: chunk })
      urls = res.data.urls ?? {}
      until = res.data.expiresAt - MARGIN_MS
    } catch (err) {
      console.warn('[photos] lookup failed', err)
    }
    for (const ref of chunk) {
      const url = urls[ref] ?? null
      cache.set(ref, { url, until })
      for (const resolve of batch.get(ref) ?? []) resolve(url)
    }
  }
}

// A displayable URL for a stored photo value, or null if the viewer may not
// see it (or it no longer exists).
export function resolvePhoto(value: string): Promise<string | null> {
  if (!isPhotoRef(value)) return Promise.resolve(value)
  ownerCheck()
  const hit = cache.get(value)
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.url)
  return new Promise((resolve) => {
    queued.set(value, [...(queued.get(value) ?? []), resolve])
    if (!scheduled) {
      scheduled = true
      queueMicrotask(() => void flush())
    }
  })
}

// The URL already known for a value (undefined: not resolved yet).
export function cachedPhoto(value: string): string | null | undefined {
  if (!isPhotoRef(value)) return value
  ownerCheck()
  const hit = cache.get(value)
  return hit && hit.until > Date.now() ? hit.url : undefined
}

// Drop one cached URL (e.g. the image failed to load: expired early).
export function forgetPhoto(value: string): void {
  cache.delete(value)
}

// URLs the server already signed (the Explore deck), cached like looked-up ones.
export function primePhotoUrls(urls: Record<string, string>, expiresAt: number): void {
  ownerCheck()
  for (const [ref, url] of Object.entries(urls)) cache.set(ref, { url, until: expiresAt - MARGIN_MS })
}
