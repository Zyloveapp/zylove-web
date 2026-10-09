import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// Admin trust dashboard (functions/src/trustAdmin.ts). Every call is
// audit-logged server-side.

export interface Reason {
  key: string
  points: number
  text: string
}
export type FlagStatus = 'open' | 'dismissed' | 'actioned'

export interface TrustSummary {
  uid: string
  name: string
  photoRef: string | null
  memberSince: string | null
  score: number
  reasons: Reason[]
  status: FlagStatus | null
  openedAt: number | null
  visibilityReduced: boolean
  suspended: boolean
}

export interface TrustDetail {
  uid: string
  name: string
  memberSince: string | null
  accountAgeDays: number | null
  photoCount: number
  verificationStatus: string
  isFounder: boolean
  visibilityReduced: boolean
  suspended: boolean
  suspendedUntil: number | null
  score: number | null
  reasons: Reason[]
  features: Record<string, number | boolean | null> | null
  computedAt: number | null
  cohort: string | null
  cohortMedians: Record<string, number>
  cohortSize: number | null
  flag: { status: FlagStatus; openedAt: number | null; closedAt: number | null; closeReason: string | null } | null
  linked: { uid: string; via: string[]; name: string; deleted: boolean; flagged: boolean; score: number | null }[]
  // Spark and Play matches (F-062 follow-up). otherPlayName: the partner's
  // Play name, for Play matches only.
  matches: { matchId: string; mode: 'spark' | 'play'; otherUid: string; otherName: string; otherPlayName: string | null; matchedAt: number | null; status: 'active' | 'ended' | 'blocked' }[]
  reports: { total: number; reporters: number; urgent: number; pending: number; byCategory: Record<string, number> }
  blocksReceived: number
  history: { action: string; actor: string; reason: string | null; at: number | null }[]
  // T&S Phase 2
  suspendedPendingReview: boolean
  suspendSource: string | null
  // F-074: out of Explore after scam reports, until an admin acts here.
  hiddenPendingReview: { at: number | null; reporters: number } | null
  countryCheck: { ip: string | null; phone: string | null; city: string | null } | null
  scamTraps: { hits: string[]; excerpt: string; at: number | null }[]
  duplicatePhotos: { otherUid: string; otherName: string; distance: number; status: string; photos: { mine: string | null; theirs: string | null }[] }[]
  photoChecks: { path: string; ai: number | null; deepfake: number | null; web: { full: number; pages: number; sample: string[] } | null }[]
}

export type TrustAction = 'dismiss' | 'reduce_visibility' | 'restore_visibility' | 'suspend' | 'lift_suspension'

const call = <Req, Res>(name: string) => (data: Req) => httpsCallable<Req, Res>(functions, name)(data).then((r) => r.data)

export const getTrustQueue = (status: FlagStatus) => call<{ status: FlagStatus }, { flags: TrustSummary[] }>('adminTrustQueue')({ status })
export const getTrustDetail = (uid: string) => call<{ uid: string }, TrustDetail>('adminTrustDetail')({ uid })
export const viewProfile = (uid: string) =>
  call<{ uid: string }, { uid: string; profile: Record<string, unknown>; sparkBio: string | null }>('adminViewProfile')({ uid })
export const trustAction = (uid: string, action: TrustAction, reason: string, days?: number) =>
  call<{ uid: string; action: TrustAction; reason: string; days?: number }, { ok: true }>('adminTrustAction')({ uid, action, reason, ...(days ? { days } : {}) })
export const searchUsers = (q: string) => call<{ q: string }, { results: TrustSummary[] }>('adminSearchUsers')({ q })

// T&S Phase 2: the per-city probation switch (server-only, off by default).
export interface ProbationCity {
  cityId: string
  name: string
  enabled: boolean
  days: number
  likesPerDay: number
}
export const getProbation = () => call<Record<string, never>, { cities: ProbationCity[] }>('adminGetProbation')({})
export const setProbation = (cityId: string, enabled: boolean, reason: string) =>
  call<{ cityId: string; enabled: boolean; reason: string }, { ok: true }>('adminSetProbation')({ cityId, enabled, reason })
