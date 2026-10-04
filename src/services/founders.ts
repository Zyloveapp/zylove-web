import { doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { requestLocation, saveUserLocation } from './location'
import { cityConfigPath, getNearestCity, type ZyloveCity } from '../config/cities'

export type FounderResult =
  | { eligible: true; cohortNumber: number; cityId?: string; cityName?: string }
  | { eligible: false; reason: string }

export type Bucket = 'women' | 'men'

// Founding circles are opt-in: people in a launch city with a spot open in
// their half are invited (end of onboarding, their profile, or a claim
// text), and assignFounderBadge makes it official. Founders then keep
// their spot by staying active (functions/src/founderActivity.ts).

const DEFAULT_FOUNDER_TARGET = 50
// Everyone else counts toward the other half (as in functions/src/founders.ts).
const MEN_IDENTITIES = new Set(['man', 'trans_man'])
const HEARTBEAT_MS = 60 * 60 * 1000

export function bucketFor(genderIdentity: unknown): Bucket {
  const g = Array.isArray(genderIdentity) ? genderIdentity[0] : genderIdentity
  return typeof g === 'string' && MEN_IDENTITIES.has(g) ? 'men' : 'women'
}

const count = (v: unknown) => (typeof v === 'number' ? v : 0)

// Whether a spot is open in this city and half. Austin also counts founder
// codes, which only config/launch records, so it goes by the higher count
// (as the server does).
export async function spotOpen(cityId: string, bucket: Bucket): Promise<boolean> {
  const key = bucket === 'women' ? 'womenCount' : 'menCount'
  const [city, launch] = await Promise.all([
    getDoc(doc(db, cityConfigPath(cityId))),
    cityId === 'austin' ? getDoc(doc(db, 'config/launch')) : Promise.resolve(null),
  ])
  const c = city.data() ?? {}
  const target = typeof c.founderTarget === 'number' ? c.founderTarget : DEFAULT_FOUNDER_TARGET
  return Math.max(count(c[key]), count(launch?.data()?.[key])) < target
}

export interface FounderOffer {
  city: ZyloveCity
  bucket: Bucket
  // Has granted SMS consent (from either mode).
  smsConsented: boolean
}

// A founder spot this user could take now, or null: already a founder,
// converted, outside every launch city, their half is full, or anything
// failed. ask: request the browser location when none is saved (onboarding
// does; the profile banner doesn't). Never throws.
export async function founderOffer(uid: string, { ask }: { ask: boolean }): Promise<FounderOffer | null> {
  try {
    const ref = doc(db, 'users', uid)
    let user = (await getDoc(ref)).data()
    if (!user || user.isFounder === true || user.founderStatus === 'converted') return null
    if (typeof user.locationLat !== 'number' || typeof user.locationLng !== 'number') {
      if (!ask) return null
      const fresh = await requestLocation()
      if (!fresh) return null
      await saveUserLocation(uid, fresh)
      user = (await getDoc(ref)).data()
      if (typeof user?.locationLat !== 'number' || typeof user?.locationLng !== 'number') return null
    }
    const city = getNearestCity(user.locationLat, user.locationLng)
    if (!city) return null
    const bucket = bucketFor(user.genderIdentity)
    if (!(await spotOpen(city.id, bucket))) return null
    return { city, bucket, smsConsented: typeof user.smsConsent === 'object' && user.smsConsent !== null }
  } catch {
    return null
  }
}

async function savedLocation(uid: string): Promise<{ locationLat: number; locationLng: number } | null> {
  const d = (await getDoc(doc(db, 'users', uid))).data()
  return typeof d?.locationLat === 'number' && typeof d?.locationLng === 'number'
    ? { locationLat: d.locationLat, locationLng: d.locationLng }
    : null
}

// "I'm in": asks the server for the spot. Resolves to null on a network or
// location failure; { eligible: false, reason: 'cohort_full' } means someone
// else got there first.
export async function claimFounderBadge(uid: string): Promise<FounderResult | null> {
  try {
    let location = await savedLocation(uid)
    if (!location) {
      const fresh = await requestLocation()
      if (!fresh) return null
      await saveUserLocation(uid, fresh)
      location = await savedLocation(uid)
      if (!location) return null
    }
    const { data } = await httpsCallable<typeof location, FounderResult>(functions, 'assignFounderBadge', { timeout: 15_000 })(
      location,
    )
    return data
  } catch {
    return null
  }
}

// The invitation was shown; the profile can offer it again later.
export function markFounderInviteShown(uid: string): Promise<void> {
  return updateDoc(doc(db, 'users', uid), { founderInviteShownAt: serverTimestamp() }).catch(() => {})
}

// "Don't show this again" on the profile banner.
export function dismissFounderInvite(uid: string): Promise<void> {
  return updateDoc(doc(db, 'users', uid), { founderInviteDismissedAt: serverTimestamp() }).catch(() => {})
}

function heartbeatKey(uid: string): string {
  return `zylove_founder_heartbeat_${uid}`
}

// Tells the server an active founder is around, at most once an hour per
// browser. The server ignores non-founders, so a stale isFounder is harmless.
// Fire and forget; never throws.
export async function founderHeartbeat(uid: string): Promise<void> {
  try {
    const last = Number(localStorage.getItem(heartbeatKey(uid)))
    if (last > 0 && Date.now() - last < HEARTBEAT_MS) return
    const user = (await getDoc(doc(db, 'users', uid))).data()
    if (user?.isFounder !== true || (user.founderStatus !== 'active' && user.founderStatus !== 'pending_revocation')) return
    await httpsCallable(functions, 'founderHeartbeat', { timeout: 10_000 })({})
    localStorage.setItem(heartbeatKey(uid), String(Date.now()))
  } catch {
    // Next load tries again.
  }
}
