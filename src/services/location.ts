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

function snap(v: number): number {
  return Math.round(Math.round(v / GRID_DEG) * GRID_DEG * 1000) / 1000
}

// Set in this browser whenever a position comes back, cleared when it's
// refused. Safari's Permissions API reports 'prompt' for geolocation even
// when the site is set to Allow, so it can't be trusted to say "granted".
const ALLOWED_KEY = 'zylove_location_allowed'

export function locationRemembered(): boolean {
  try {
    return localStorage.getItem(ALLOWED_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberLocation(allowed: boolean): void {
  try {
    if (allowed) localStorage.setItem(ALLOWED_KEY, '1')
    else localStorage.removeItem(ALLOWED_KEY)
  } catch {
    // Storage unavailable: we just won't remember.
  }
}

let pending: Promise<LatLng | null> | null = null

// Browser position, or null if unsupported, denied or timed out. Never throws.
// Concurrent callers share one request, so the user sees one prompt.
export function requestLocation(): Promise<LatLng | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null)
  pending ??= new Promise<LatLng | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        rememberLocation(true)
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude })
      },
      (err) => {
        console.warn('[location] getCurrentPosition failed', err.code, err.message)
        if (err.code === err.PERMISSION_DENIED) rememberLocation(false)
        resolve(null)
      },
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
    // Bounded: the save waits on this.
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
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

// Whether geolocation is already allowed, without asking: 'granted' from the
// Permissions API, or — where it says 'prompt' or isn't there (Safari) — a
// position this browser has handed over before.
async function locationAllowed(): Promise<boolean> {
  try {
    if (!navigator.permissions?.query) return locationRemembered()
    const { state } = await navigator.permissions.query({ name: 'geolocation' })
    return state === 'granted' || (state === 'prompt' && locationRemembered())
  } catch {
    return locationRemembered()
  }
}

// Every app load: if location is already granted, quietly take the current
// position and save it — never a prompt (LocationGate does the asking).
// When the snapped position hasn't moved, only locationUpdatedAt is touched,
// so there's no reverse-geocode call or label rewrite on a normal visit.
// Fire and forget; never throws.
export async function refreshLocationSilently(uid: string): Promise<void> {
  try {
    if (!(await locationAllowed())) return
    const location = await requestLocation()
    if (!location) return
    const ref = doc(db, 'users', uid)
    const data = (await getDoc(ref)).data()
    if (!data) return
    const unmoved =
      data.locationLat === snap(location.lat) && data.locationLng === snap(location.lng) && typeof data.locationLabel === 'string'
    if (unmoved) await updateDoc(ref, { locationUpdatedAt: serverTimestamp() })
    else await saveUserLocation(uid, location)
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

// A profile's coordinates: locationLat/locationLng (people) or the
// _location map ({ latitude, longitude }) the seeded bots carry. Null when
// neither is there.
export function coordsOf(p: object | null | undefined): LatLng | null {
  const d = (p ?? {}) as Record<string, unknown>
  if (typeof d.locationLat === 'number' && typeof d.locationLng === 'number') return { lat: d.locationLat, lng: d.locationLng }
  const geo = d._location as { latitude?: unknown; longitude?: unknown } | undefined
  if (typeof geo?.latitude === 'number' && typeof geo?.longitude === 'number') return { lat: geo.latitude, lng: geo.longitude }
  return null
}

// "Less than a mile away", "1 mile away", "12 miles away". Both ends are
// snapped to ~3 miles, so it's approximate by design.
export function distanceText(miles: number): string {
  const rounded = Math.round(miles)
  if (miles < 1 || rounded < 1) return 'Less than a mile away'
  return rounded === 1 ? '1 mile away' : `${rounded.toLocaleString()} miles away`
}
