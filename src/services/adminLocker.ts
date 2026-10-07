import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// T&S Phase 4 — the evidence locker and appeals (admin). Every call is
// audit-logged server-side; opening an item's contents is its own entry.

export interface LockerRow {
  id: string
  reporterUid: string
  reporterName: string
  reportedUid: string
  reportedName: string
  categories: string[]
  createdAt: number
  summary: { items: number; verified: number; unverified: number; mismatch: number; photos: number }
  status: 'open' | 'decided'
  decision: 'actioned' | 'no_action' | null
  decidedAt: number | null
  ncmec: boolean
  appealPending: boolean
  legalHold: { kind: string; by: string; at: number; reason: string } | null
  expiresAt: number | null
}
export interface LockerItem {
  msgId: string
  from: 'reporter' | 'reported'
  sentAt: number | null
  type: 'text' | 'photo'
  text: string | null
  photo: string | null
  verdict: 'verified' | 'unverified' | 'mismatch'
}
export interface Appeal {
  id: string
  uid: string
  name: string
  note: string
  status: 'pending' | 'upheld' | 'overturned'
  submittedAt: number
  suspendedAt: number
  suspendSource: string | null
  stillSuspended: boolean
  decisionReason: string | null
  decidedAt: number | null
}

const call = <Req, Res>(name: string) => (data: Req) => httpsCallable<Req, Res>(functions, name)(data).then((r) => r.data)
export const listLocker = (status: string, category: string | null) => call<{ status: string; category: string | null }, { items: LockerRow[] }>('adminLockerList')({ status, category })
export const lockerDetail = (id: string) => call<{ id: string }, LockerRow & { items: LockerItem[] }>('adminLockerDetail')({ id })
export const decideLocker = (id: string, decision: 'actioned' | 'no_action', ncmec: boolean, reason: string) =>
  call<Record<string, unknown>, { ok: true }>('adminLockerDecide')({ id, decision, ncmec, reason })
export const holdLocker = (id: string, hold: boolean, kind: string, reason: string) => call<Record<string, unknown>, { ok: true }>('adminLockerHold')({ id, hold, kind, reason })
export const listAppeals = (status: 'pending' | 'decided') => call<{ status: string }, { appeals: Appeal[] }>('adminListAppeals')({ status })
export const decideAppeal = (id: string, decision: 'upheld' | 'overturned', reason: string) => call<Record<string, unknown>, { ok: true }>('adminDecideAppeal')({ id, decision, reason })
