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
