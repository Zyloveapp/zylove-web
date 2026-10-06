import { httpsCallable } from 'firebase/functions'
import { auth, functions } from './firebase'

// How far away other people are, from the server (getDistances): whole miles
// between the two saved locations, and whether they're in the viewer's launch
// market. Nobody's coordinates ever reach the browser.
//
// Lookups made in the same tick are sent together (up to 200 per call) and
// cached for the session. null: one side has no saved location.

export interface Distance {
  miles: number
  sameMarket: boolean
}

const BATCH = 200
const cache = new Map<string, Distance | null>()
let cacheOwner: string | null = null
let queued = new Map<string, ((d: Distance | null) => void)[]>()
let scheduled = false

function ownerCheck() {
  const viewer = auth.currentUser?.uid ?? null
  if (viewer !== cacheOwner) {
    cache.clear()
    cacheOwner = viewer
  }
}

// After the viewer's own location changes.
export function clearDistances(): void {
  cache.clear()
}

async function fetchBatch(uids: string[]): Promise<Record<string, Distance>> {
  try {
    const res = await httpsCallable<{ uids: string[] }, { distances: Record<string, Distance> }>(functions, 'getDistances')({ uids })
    return res.data.distances ?? {}
  } catch (err) {
    console.warn('[distances] lookup failed', err)
    return {}
  }
}

async function flush() {
  scheduled = false
  const batch = queued
  queued = new Map()
  const uids = [...batch.keys()]
  for (let i = 0; i < uids.length; i += BATCH) {
    const chunk = uids.slice(i, i + BATCH)
    const found = await fetchBatch(chunk)
    for (const uid of chunk) {
      const d = found[uid] ?? null
      cache.set(uid, d)
      for (const resolve of batch.get(uid) ?? []) resolve(d)
    }
  }
}

export function getDistance(uid: string): Promise<Distance | null> {
  ownerCheck()
  if (cache.has(uid)) return Promise.resolve(cache.get(uid) ?? null)
  return new Promise((resolve) => {
    queued.set(uid, [...(queued.get(uid) ?? []), resolve])
    if (!scheduled) {
      scheduled = true
      queueMicrotask(() => void flush())
    }
  })
}

// Distances for many people at once (Explore), keyed by uid.
export async function getDistances(uids: string[]): Promise<Map<string, Distance>> {
  const results = await Promise.all(uids.map((u) => getDistance(u).then((d) => [u, d] as const)))
  return new Map(results.filter((r): r is readonly [string, Distance] => r[1] !== null))
}

// Distance already known for uid (undefined: not looked up yet).
export function cachedDistance(uid: string): Distance | null | undefined {
  ownerCheck()
  return cache.get(uid)
}
