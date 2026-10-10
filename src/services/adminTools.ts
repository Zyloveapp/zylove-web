import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// Admin dashboards (functions/src/adminTools.ts). Every call is checked
// server-side for the admin auth claim.

// grace: asked to delete, can still cancel · deleted: soft-deleted,
// restorable for 90 days · record: data purged, recovery record left.
export type DeletionStage = 'grace' | 'deleted' | 'record'

export interface PendingDeletion {
  uid: string
  stage: DeletionStage
  displayName: string | null
  phoneLast4: string | null
  banned: boolean
  deletedAt: number | null
  // When the next automatic step removes their data for good; null = never
  // (a banned record) or unknown.
  permanentAt: number | null
}

export async function listDeletions(): Promise<PendingDeletion[]> {
  const { data } = await httpsCallable<void, { deletions: PendingDeletion[] }>(functions, 'adminListDeletions')()
  return data.deletions
}

export async function purgeAccount(uid: string): Promise<{ keptBannedRecord: boolean }> {
  const { data } = await httpsCallable<{ uid: string }, { purged: true; keptBannedRecord: boolean }>(
    functions,
    'adminPurgeAccount',
    { timeout: 300_000 },
  )({ uid })
  return data
}

export interface CityRow {
  id: string
  name: string
  state: string
  live: boolean
  status: CityStatus // Austin-only launch: locked (waitlist only), founding, live
  waitlist: number // still waiting for this city
  founderInterest: number // in its founder line
  members: number
  women: number
  men: number
  target: number // per half
  sparkPlus: number
  elite: number
  newSignups7d: number
  lastFounderAt: number | null
}

export interface CityStats {
  totals: { founders: number; capacity: number; subscribers: number; paying: number; activeUsers: number; outsideCities: number }
  cities: CityRow[]
  generatedAt: number
}

export async function cityStats(): Promise<CityStats> {
  const { data } = await httpsCallable<void, CityStats>(functions, 'adminCityStats', { timeout: 120_000 })()
  return data
}

export type CityStatus = 'locked' | 'founding' | 'live'

// Unlock (→ founding), Go live, Lock (functions/src/waitlist.ts
// adminSetCityStatus; re-checks the live admin claim).
export async function setCityStatus(cityId: string, status: CityStatus): Promise<void> {
  await httpsCallable<{ cityId: string; status: CityStatus }, unknown>(functions, 'adminSetCityStatus')({ cityId, status })
}

// CSP violation counts per day (functions/src/cspReports.ts, F-082): what the
// Report-Only script policy would block, by directive and blocked host.
export interface CspDayCounts {
  day: string // YYYY-MM-DD, UTC
  total: number
  counts: { directive: string; host: string; n: number }[]
}

export async function cspReports(): Promise<CspDayCounts[]> {
  const { data } = await httpsCallable<void, { days: CspDayCounts[] }>(functions, 'adminCspReports')()
  return data.days
}
