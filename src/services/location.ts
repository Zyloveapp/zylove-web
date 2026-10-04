import { doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { db } from './firebase'

export interface LatLng {
  lat: number
  lng: number
}

// users/{uid} is readable by every signed-in user, so coordinates are stored
// snapped to a coarse grid (~3 miles) rather than as raw GPS. Plenty for
// "~X mi away" and the Austin sort; not enough to place someone's home.
const GRID_DEG = 0.05
const STALE_MS = 7 * 24 * 60 * 60 * 1000

function snap(v: number): number {
  return Math.round(Math.round(v / GRID_DEG) * GRID_DEG * 1000) / 1000
}

let pending: Promise<LatLng | null> | null = null

// Browser position, or null if unsupported, denied or timed out. Never throws.
// Concurrent callers share one request, so the user sees one prompt.
export function requestLocation(): Promise<LatLng | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null)
  pending ??= new Promise<LatLng | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 10000, maximumAge: 300000 },
    )
  }).finally(() => {
    pending = null
  })
  return pending
}

// "Austin, TX" style label from OpenStreetMap's free reverse geocoder, or
// null on any failure.
async function reverseGeocode({ lat, lng }: LatLng): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10&addressdetails=1`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const data: unknown = await res.json()
    const address = (data as { address?: Record<string, string> }).address ?? {}
    const city = address.city ?? address.town ?? address.village ?? address.municipality ?? address.county
    // ISO3166-2-lvl4 is "US-TX"; fall back to the full state name.
    const code = address['ISO3166-2-lvl4']
    const state = code?.includes('-') ? code.split('-')[1] : address.state
    return city ? (state ? `${city}, ${state}` : city) : (state ?? null)
  } catch {
    return null
  }
}

// Saves a snapped location (and label) on an existing users/{uid} doc. A
// missing doc is left alone: onboarding creates it, and writing here first
// would make onboarding treat a new user as an existing one.
export async function saveUserLocation(uid: string, location: LatLng): Promise<void> {
  const ref = doc(db, 'users', uid)
  const snapshot = await getDoc(ref)
  if (!snapshot.exists()) return
  const snapped = { lat: snap(location.lat), lng: snap(location.lng) }
  const label = await reverseGeocode(snapped)
  await updateDoc(ref, {
    locationLat: snapped.lat,
    locationLng: snapped.lng,
    ...(label && { locationLabel: label }),
    locationUpdatedAt: serverTimestamp(),
  })
}

// Background refresh: when there's no saved location or it's over 7 days old,
// asks the browser and saves. Fire and forget; never throws.
export async function refreshLocationIfStale(uid: string): Promise<void> {
  try {
    const data = (await getDoc(doc(db, 'users', uid))).data()
    if (!data) return
    const updated: unknown = data.locationUpdatedAt
    const updatedMs =
      typeof updated === 'object' && updated !== null && 'toMillis' in updated && typeof updated.toMillis === 'function'
        ? (updated.toMillis() as number)
        : null
    const fresh = typeof data.locationLat === 'number' && updatedMs !== null && Date.now() - updatedMs < STALE_MS
    if (fresh) return
    const location = await requestLocation()
    if (location) await saveUserLocation(uid, location)
  } catch {
    // Location is a nice-to-have; never surface failures.
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
