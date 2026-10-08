import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { audit } from './audit'
import { linkedAccounts } from './devices'
import { refreshEntry } from './explore'
import { suspendAccount } from './reports'
import { rescoreTrust } from './trustScore'
import { isAdminUid } from './userData'
import { queueAdminAlert } from './adminAlerts'

// T&S Phase 2 — "Report scam". Two scam reports within SCAM_WINDOW_MS from
// different people suspend the account PENDING REVIEW (never a ban, never
// timed): the reporters must each be at least REPORTER_MIN_AGE_MS old and
// not linked to each other by device or IP — so one person with two
// accounts can't take someone down. The suspension opens a trust flag; an
// admin confirms or lifts it from /admin/trust.

export const SCAM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
export const REPORTER_MIN_AGE_MS = 48 * 60 * 60 * 1000
export const SCAM_REPORTS_TO_SUSPEND = 2

const db = () => getFirestore()
const isBot = (uid: string) => /^(zbot|seed)-/.test(uid)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

async function createdAt(uids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const internals = await db().getAll(...uids.map((u) => db().doc(`userInternal/${u}`)))
  const missing: string[] = []
  internals.forEach((d, i) => {
    const at = num(d.data()?.accountCreatedAt)
    if (at > 0) out.set(uids[i], at)
    else missing.push(uids[i])
  })
  if (missing.length) {
    const res = await getAuth()
      .getUsers(missing.map((uid) => ({ uid })))
      .catch(() => null)
    for (const u of res?.users ?? []) out.set(u.uid, new Date(u.metadata.creationTime).getTime())
  }
  return out
}

// The qualifying reporters: old enough, and pairwise unlinked. Pure apart
// from the linked lookup, so the rule is easy to read and test.
export function independentReporters(
  reporters: string[],
  created: Map<string, number>,
  linkedTo: Map<string, Set<string>>,
  now = Date.now(),
): string[] {
  const old = reporters.filter((r) => {
    const at = created.get(r)
    return at !== undefined && now - at >= REPORTER_MIN_AGE_MS
  })
  // Greedy: keep a reporter only if not linked (either way) to one kept.
  const kept: string[] = []
  for (const r of old) {
    if (kept.some((k) => linkedTo.get(r)?.has(k) || linkedTo.get(k)?.has(r))) continue
    kept.push(r)
  }
  return kept
}

export async function checkScamSuspension(uid: string): Promise<boolean> {
  if (isBot(uid) || (await isAdminUid(uid))) return false
  const internal = (await db().doc(`userInternal/${uid}`).get()).data() ?? {}
  if (internal.isSuspended === true) return false
  const now = Date.now()
  const snap = await db().collection('reports').where('reportedUid', '==', uid).get()
  const reporters = [
    ...new Set(
      snap.docs
        .map((d) => d.data() as DocumentData)
        .filter((r) => {
          const cats = Array.isArray(r.categories) ? (r.categories as string[]) : [r.category]
          const at = num(r.reportedAt) || (r.updatedAt instanceof Timestamp ? r.updatedAt.toMillis() : 0)
          return cats.includes('scam') && now - at <= SCAM_WINDOW_MS && typeof r.reporterUid === 'string'
        })
        .map((r) => r.reporterUid as string),
    ),
  ]
  if (reporters.length < SCAM_REPORTS_TO_SUSPEND) return false
  const [created, links] = await Promise.all([createdAt(reporters), Promise.all(reporters.map((r) => linkedAccounts(r)))])
  const linkedTo = new Map(reporters.map((r, i) => [r, new Set(links[i].map((l) => l.uid))]))
  const independent = independentReporters(reporters, created, linkedTo, now)
  if (independent.length < SCAM_REPORTS_TO_SUSPEND) {
    logger.info('scamReports: not enough independent reporters', { reporters: reporters.length, independent: independent.length })
    return false
  }
  await suspendAccount(uid, null, 'system', 'auto_scam')
  await refreshEntry(uid)
  await audit({
    actor: 'system',
    action: 'trust.auto_suspend',
    target: uid,
    reason: `Reported as a scam by ${independent.length} unlinked accounts within 30 days — suspended pending review`,
    detail: { reporters: independent.length },
  })
  // The flag (scam_reports reason) puts it at the top of the review queue.
  await rescoreTrust(uid)
  await queueAdminAlert('scamSuspend')
  logger.warn('scamReports: account suspended pending review', { reporters: independent.length })
  return true
}
