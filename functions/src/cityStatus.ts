import { getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { ZYLOVE_CITIES, distanceMiles, type ZyloveCity } from './cities'

// Austin-only launch (Matthew, 2026-10-09): each launch city is
//
//   locked    waitlist only — new accounts there are waitlisted, no profile.
//             Every city but Austin until an admin unlocks it.
//   founding  sign-ups open, founder circle, AI profiles fill the deck (the
//             old "pre-launch"). Austin.
//   live      full launch, AI profiles retired (the old "open": discovery
//             opened, bots off) — automatic when the founder circle fills,
//             or an admin's "Go live".
//
// Stored as config/city_{id}.status (server-only writes, adminSetCityStatus).
// A city doc without one goes by the old flags: open → live, else Austin
// founding and the rest locked. Locking a city never removes its members:
// `unlockedAt` (set by the first unlock) keeps a locked-again city serving
// the people already there — only new sign-ups stop.

export type CityStatus = 'locked' | 'founding' | 'live'
export const CITY_STATUSES: readonly CityStatus[] = ['locked', 'founding', 'live']
export const DEFAULT_FOUNDING: ReadonlySet<string> = new Set(['austin'])

// The old "open" (trial.ts cityOpen): discovery opened, bots off.
export function openFlags(config: DocumentData | undefined): boolean {
  return config?.discoveryOpenedAt != null || config?.botsActive === false
}

export function cityStatus(id: string, config: DocumentData | undefined): CityStatus {
  const s: unknown = config?.status
  if (typeof s === 'string' && (CITY_STATUSES as readonly string[]).includes(s)) return s as CityStatus
  if (openFlags(config)) return 'live'
  return DEFAULT_FOUNDING.has(id) ? 'founding' : 'locked'
}

// New accounts inside it go on to onboarding.
export const admitsSignups = (status: CityStatus) => status !== 'locked'

// Its members get a deck there (founding or live, or locked again after an
// unlock — "lock never removes existing members").
export function servesMembers(id: string, config: DocumentData | undefined): boolean {
  return cityStatus(id, config) !== 'locked' || config?.unlockedAt != null || (DEFAULT_FOUNDING.has(id) && config?.status === 'locked')
}

// Founding perks (pre-launch Elite, AI profiles in the deck, founder claims):
// a city that serves members and hasn't gone live.
export function foundingPeriod(id: string, config: DocumentData | undefined): boolean {
  return servesMembers(id, config) && !openFlags(config) && cityStatus(id, config) !== 'live'
}

export type CityConfigs = Map<string, DocumentData | undefined>

// The launch city whose radius covers the point and passes `ok`, nearest first.
export function cityAt(lat: number, lng: number, ok: (city: ZyloveCity) => boolean): ZyloveCity | null {
  let best: { city: ZyloveCity; miles: number } | null = null
  for (const city of ZYLOVE_CITIES) {
    const miles = distanceMiles(lat, lng, city.lat, city.lng)
    if (miles <= city.radiusMiles && ok(city) && (!best || miles < best.miles)) best = { city, miles }
  }
  return best?.city ?? null
}

// The nearest launch city at any distance — the one a waitlister waits for.
export function nearestLaunchCity(lat: number, lng: number): ZyloveCity {
  return ZYLOVE_CITIES.reduce((a, c) => (distanceMiles(lat, lng, c.lat, c.lng) < distanceMiles(lat, lng, a.lat, a.lng) ? c : a))
}

// Where a new account may sign up: inside a Founding or Live city.
export function admittingCityAt(lat: number, lng: number, configs: CityConfigs): ZyloveCity | null {
  return cityAt(lat, lng, (c) => admitsSignups(cityStatus(c.id, configs.get(c.id))))
}

// Where members get a deck ("Zylove isn't live here yet" outside all of them).
export function servingCityAt(lat: number, lng: number, configs: CityConfigs): ZyloveCity | null {
  return cityAt(lat, lng, (c) => servesMembers(c.id, configs.get(c.id)))
}

// The cities named on the waitlist screen ("available in …").
export function availableCities(configs: CityConfigs): ZyloveCity[] {
  return ZYLOVE_CITIES.filter((c) => admitsSignups(cityStatus(c.id, configs.get(c.id))))
}

// Every launch city's config doc, one read each (24 docs).
export async function loadCityConfigs(): Promise<CityConfigs> {
  const db = getFirestore()
  const snaps = await db.getAll(...ZYLOVE_CITIES.map((c) => db.doc(`config/city_${c.id}`)))
  return new Map(ZYLOVE_CITIES.map((c, i) => [c.id, snaps[i]?.data()]))
}

// The config docs of just the launch cities whose radius covers the point
// (usually none or one) — for the per-call checks (deck, founder claim).
export async function configsAt(lat: number, lng: number): Promise<CityConfigs> {
  const covering = ZYLOVE_CITIES.filter((c) => distanceMiles(lat, lng, c.lat, c.lng) <= c.radiusMiles)
  if (!covering.length) return new Map()
  const db = getFirestore()
  const snaps = await db.getAll(...covering.map((c) => db.doc(`config/city_${c.id}`)))
  return new Map(covering.map((c, i) => [c.id, snaps[i]?.data()]))
}
