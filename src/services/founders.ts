import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { requestLocation, saveUserLocation } from './location'

export type FounderResult = { eligible: true; cohortNumber: number } | { eligible: false; reason: string }

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
    return data
  } catch {
    return null
  }
}
