import { getDoc } from 'firebase/firestore'
import { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'
import { accountDoc } from './subscription'
import { clearDistances } from './distances'

export interface LatLng {
  lat: number
  lng: number
}

// Locations are server-side (functions/src/location.ts): setLocation snaps the
// browser's position to a ~1-mile grid and keeps it where no other user can
// read it; the owner gets a summary in private/account ({ lat, lng, label,
// marketCityId }). Other people's distances come from getDistances.
// The location is taken only when the user asks: Explore's first-time gate
// or Settings → Update location. Never on app load.

// Left behind by an earlier build; nothing reads it any more.
try {
  localStorage.removeItem('zylove_location_allowed')
} catch {
  // ignore
}

let pending: Promise<LatLng | null> | null = null
let lastDenied = false

// Whether the most recent requestLocation() failed because the user or
// browser refused (as opposed to a timeout or no fix).
export function lastLocationDenied(): boolean {
  return lastDenied
}

// Browser position, or null if unsupported, denied or timed out. Never throws.
// Concurrent callers share one request, so the user sees one prompt.
export function requestLocation(): Promise<LatLng | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null)
  pending ??= new Promise<LatLng | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lastDenied = false
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude })
      },
      (err) => {
        console.warn('[location] getCurrentPosition failed', location.origin, err.code, err.message)
        lastDenied = err.code === err.PERMISSION_DENIED
        resolve(null)
      },
      { timeout: 10000, maximumAge: 300000 },
    )
  }).finally(() => {
    pending = null
  })
  return pending
}

// The saved-location summary from private/account, or null.
export async function savedLocation(uid: string): Promise<{ lat: number; lng: number; label: string | null; marketCityId: string | null } | null> {
  const loc = (await getDoc(accountDoc(uid)).catch(() => null))?.data()?.location
  if (typeof loc?.lat !== 'number' || typeof loc?.lng !== 'number') return null
  return {
    lat: loc.lat,
    lng: loc.lng,
    label: typeof loc.label === 'string' ? loc.label : null,
    marketCityId: typeof loc.marketCityId === 'string' ? loc.marketCityId : null,
  }
}

export class LocationLimitError extends Error {}

// Saves the location server-side: whether it moved (a new ~1-mile cell) and
// the city label. Throws LocationLimitError (message: "You can update your
// location again tomorrow") past the daily limit on moves.
export async function saveUserLocation(location: LatLng): Promise<{ changed: boolean; label: string | null }> {
  try {
    const { data } = await httpsCallable<LatLng, { changed: boolean; label: string | null }>(functions, 'setLocation')({ lat: location.lat, lng: location.lng })
    if (data.changed) clearDistances()
    return { changed: data.changed === true, label: typeof data.label === 'string' ? data.label : null }
  } catch (err) {
    if (err instanceof FirebaseError && err.code === 'functions/resource-exhausted') throw new LocationLimitError(err.message)
    throw err
  }
}

// Great-circle distance in miles (haversine).
export function getDistanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// "Less than a mile away", "1 mile away", "15 miles away", "50+ miles away".
// The server sends coarse miles (whole to 10, 5-mile steps to 50, 51 = 50+),
// so it's approximate by design.
export function distanceText(miles: number): string {
  if (miles > 50) return '50+ miles away'
  const rounded = Math.round(miles)
  if (miles < 1 || rounded < 1) return 'Less than a mile away'
  return rounded === 1 ? '1 mile away' : `${rounded.toLocaleString()} miles away`
}
