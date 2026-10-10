import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'
import { WAITLIST_CONSENT_VERSION } from '../config/smsConsent'
import type { LatLng } from './location'

// Austin-only launch: the location check a new account meets before
// onboarding, and the city waitlist (functions/src/waitlist.ts).

export type AreaView =
  | { status: 'member' }
  | { status: 'admitted'; cityName: string | null; via: string | null; headStartUntil: number | null }
  | {
      status: 'waitlisted'
      cityId: string
      cityName: string
      available: { name: string; state: string }[]
      consented: boolean
      founderLine: number | null
    }
  | { status: 'unknown' }

// Without a location: where the account stands. With one: decides it.
export async function checkArea(location?: LatLng): Promise<AreaView> {
  const { data } = await httpsCallable<Partial<LatLng>, AreaView>(functions, 'checkArea', { timeout: 30_000 })(location ?? {})
  return data
}

// The waitlist's text consent (the server records the wording by version).
export async function joinWaitlistTexts(): Promise<void> {
  await httpsCallable<{ textVersion: string; source: 'waitlist' }, unknown>(functions, 'grantSmsConsent')({
    textVersion: WAITLIST_CONSENT_VERSION,
    source: 'waitlist',
  })
}

// Deletes the account and every record holding the number.
export async function leaveWaitlist(): Promise<void> {
  await httpsCallable<Record<string, never>, { ok: true }>(functions, 'leaveWaitlist', { timeout: 60_000 })({})
}

// "I'm interested": a place in the city's founder line (needs text consent).
export async function joinFounderLine(): Promise<number> {
  const { data } = await httpsCallable<Record<string, never>, { place: number }>(functions, 'joinFounderLine')({})
  return data.place
}
