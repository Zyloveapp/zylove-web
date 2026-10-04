import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// Admin report queue (functions/src/reports.ts). Reporter identities never
// reach the client — only counts.

export type Priority = 'urgent' | 'normal'
export type AccountStatus = 'active' | 'suspended' | 'banned' | 'deleted'

export interface ReportEntry {
  key: string
  categories: string[]
  reportedAt: number | null
  priority: Priority
  status: 'pending' | 'actioned' | 'cleared'
  source: string
}

export interface ReportedUser {
  uid: string
  name: string
  photoURL: string | null
  joinedAt: number | null
  status: AccountStatus
  suspendedUntil: number | null
  priority: Priority
  pendingCount: number
  pendingReporters: number
  totalReporters: number
  categories: { category: string; count: number }[]
  lastReportedAt: number | null
  lastWarnedAt: number | null
  isAdmin: boolean
  reports: ReportEntry[]
}

export interface GoodActor {
  uid: string
  name: string
  photoURL: string | null
  tier: string
  reviewCount: number
  positiveCount: number
  lastThankedAt: number | null
}

export type ModerateAction = 'warn' | 'suspend' | 'unsuspend' | 'ban' | 'clear' | 'thank'

export async function getReportSummary(): Promise<{ urgent: number; pending: number }> {
  const { data } = await httpsCallable<{ summaryOnly: true }, { urgent: number; pending: number }>(
    functions,
    'adminGetReports',
  )({ summaryOnly: true })
  return data
}

export async function getReports(): Promise<{ reported: ReportedUser[]; goodActors: GoodActor[] }> {
  const { data } = await httpsCallable<object, { reported: ReportedUser[]; goodActors: GoodActor[] }>(
    functions,
    'adminGetReports',
    { timeout: 60_000 },
  )({})
  return { reported: data.reported ?? [], goodActors: data.goodActors ?? [] }
}

export async function moderate(
  uid: string,
  action: ModerateAction,
  opts: { days?: 30 | 60 | 90; message?: string } = {},
): Promise<{ resolved?: number; texted?: boolean; phoneBanned?: boolean }> {
  const { data } = await httpsCallable<
    { uid: string; action: ModerateAction; days?: number; message?: string },
    { ok: true; resolved?: number; texted?: boolean; phoneBanned?: boolean }
  >(functions, 'adminModerate', { timeout: 120_000 })({ uid, action, ...opts })
  return data
}
