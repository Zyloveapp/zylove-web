import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { requestLocation, saveUserLocation } from './location'

export type FounderResult =
  | { eligible: true; cohortNumber: number; cityId?: string; cityName?: string }
  | { eligible: false; reason: string }

// Answers that settle it for this user: earned, already a founder, outside
// every launch city, or their city's circle is full. Anything else (no location, network, the
// function not deployed yet, no profile) is tried again next time.
const FINAL_REASONS = new Set(['already_assigned', 'outside_coverage', 'outside_austin', 'cohort_full'])

function checkedKey(uid: string): string {
  return `zylove_founder_checked_${uid}`
}

// True once this browser has had a settled answer for this user.
export function founderCheckDone(uid: string): boolean {
  try {
    return localStorage.getItem(checkedKey(uid)) === '1'
  } catch {
    return false
  }
}

function markFounderChecked(uid: string): void {
  try {
    localStorage.setItem(checkedKey(uid), '1')
  } catch {
    // Storage unavailable: the server answer is idempotent, so a repeat is harmless.
  }
}

async function savedLocation(uid: string): Promise<{ locationLat: number; locationLng: number } | null> {
  const d = (await getDoc(doc(db, 'users', uid))).data()
  return typeof d?.locationLat === 'number' && typeof d?.locationLng === 'number'
    ? { locationLat: d.locationLat, locationLng: d.locationLng }
    : null
}

// Run right after onboarding saves. New users have no saved location yet
// (it's only written once the profile exists), so ask for it here first.
// Resolves to null on any failure or a denied location: the badge never
// blocks onboarding.
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
    if (data.eligible || FINAL_REASONS.has(data.reason)) markFounderChecked(uid)
    return data
  } catch {
    return null
  }
}
