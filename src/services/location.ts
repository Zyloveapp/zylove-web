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
// browser's position to a ~3-mile grid and keeps it where no other user can
// read it; the owner gets a summary in private/account ({ lat, lng, label,
// marketCityId }). Other people's distances come from getDistances.
// The same grid as the server, so an unmoved position isn't re-sent.
const GRID_DEG = 0.05

function snap(v: number): number {
  return Math.round(Math.round(v / GRID_DEG) * GRID_DEG * 1000) / 1000
}

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

// Saves the location server-side. Throws LocationLimitError (message: "You
// can update your location again tomorrow") past the daily limit on moves.
export async function saveUserLocation(location: LatLng): Promise<void> {
  try {
    await httpsCallable(functions, 'setLocation')({ lat: location.lat, lng: location.lng })
    clearDistances()
  } catch (err) {
    if (err instanceof FirebaseError && err.code === 'functions/resource-exhausted') throw new LocationLimitError(err.message)
    throw err
  }
}

// Whether the browser has already granted geolocation, without asking.
// Only an explicit 'granted' counts: calling getCurrentPosition from
// 'prompt' without a click lets Safari record a denial the user never saw.
async function locationGranted(): Promise<boolean> {
  try {
    if (!navigator.permissions?.query) return false
    return (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'
  } catch {
    return false
  }
}

// Every app load: if location is already granted, quietly take the current
// position and save it — never a prompt (LocationGate does the asking).
// When the snapped position hasn't moved nothing is sent. Fire and forget;
// never throws (past the daily limit the move simply waits).
export async function refreshLocationSilently(uid: string): Promise<void> {
  try {
    if (!(await locationGranted())) return
    const location = await requestLocation()
    if (!location) return
    const saved = await savedLocation(uid)
    if (saved && saved.lat === snap(location.lat) && saved.lng === snap(location.lng) && saved.label) return
    await saveUserLocation(location)
  } catch (err) {
    // Location is a nice-to-have; never surface failures to the user.
    console.warn('[location] silent refresh failed', err)
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

// "Less than a mile away", "1 mile away", "12 miles away". Both ends are
// snapped to ~3 miles, so it's approximate by design.
export function distanceText(miles: number): string {
  const rounded = Math.round(miles)
  if (miles < 1 || rounded < 1) return 'Less than a mile away'
  return rounded === 1 ? '1 mile away' : `${rounded.toLocaleString()} miles away`
}
