// Reports: a member flags someone they matched with. Separate from reviews —
// a prior review, or no messages at all, never blocks a report.
//
//   reports/{reporterUid}_{reportedUid}_{generation}   one per reporter per
//     match generation; reporting again merges in new categories and reopens
//     it. Same collection mobile's reportUser writes ({…}_{timestamp} ids,
//     single `category`, tier); server-only (rules deny clients).
//   bannedPhones/{sha256(phone)}   written only by an admin ban: banned: true
//     and a reportCount past onBeforeSignIn's threshold, so the number can
//     never sign in or create an account again.
//
// Nothing is automatic, with one exception: a report only queues, and every
// action on an account is an admin's, from the dashboard — except that 2
// "scam" reports within 30 days from unlinked accounts at least 48h old
// suspend the account pending an admin's review (scamReports.ts; never a ban).
//
// Admins work the queue from /admin/reports (adminGetReports, adminModerate).
// Reporter identities never leave the server.

import { createHash, randomUUID } from 'node:crypto'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { REPORT_ONLY_IDS, REVIEW_TONE } from './shared/reviewCategories'
import { checkScamReports } from './scamReports'
import { queueAdminAlert } from './adminAlerts'
import { SMS_SECRETS, textAccount } from './sms'
import { STRIPE_SECRETS } from './stripe'
import { phoneHash, reportGeneration } from './trust'
import { takeRateLimit } from './rateLimits'
import { softDeleteAccount } from './adminActivity'
import { audit, requireAdminAudited } from './audit'
import { markBannedDevices } from './devices'
import { blocklistPhotosOf, unblockPhotosOf } from './photoHashes'
import { reportCounts } from './blocklistContext'
import { decideEvidenceFor } from './evidence'
import { isPlayMatchId, uidNamedIn } from './playIds'
import { accountRef, adminUids, internalRef, isAdminAuth, isAdminUid, isSuspendedUid, loadInternal } from './userData'

const BOT_PREFIXES = ['zbot-', 'seed-']
const URGENT = new Set(['felt_unsafe', 'aggressive', 'child_safety'])
// An admin ban: far past onBeforeSignIn's threshold.
const BANNED_REPORT_COUNT = 1000
const SUSPEND_DAYS = [30, 60, 90] as const
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_MESSAGE = 500
// "Good actors": the top Zylove Score tiers (set by submitReview).
const GOOD_TIERS = ['elite', 'trusted', 'great']

const DEFAULT_WARNING =
  'A member reported something about your recent behavior on Zylove. Please review our Community Guidelines — further reports may lead to your account being suspended.'
const DEFAULT_THANKS =
  "✦ Thank you for being one of the good ones. Members consistently say great things about connecting with you — that's what Zylove is about."

type Priority = 'urgent' | 'normal'
type ReportStatus = 'pending' | 'actioned' | 'cleared'

function db() {
  return getFirestore()
}

function str(data: unknown, key: string): string {
  const v = (data as Record<string, unknown> | null)?.[key]
  if (typeof v !== 'string' || !v || v.includes('/')) throw new HttpsError('invalid-argument', `${key} required`)
  return v
}

function millis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis()
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

// F-070: reports per reporter per day — far above any real use.
const REPORT_LIMIT = { max: 10, windowMs: DAY_MS }

const isBotUid = (uid: string) => BOT_PREFIXES.some((p) => uid.startsWith(p))

async function phoneOf(uid: string): Promise<string | null> {
  return getAuth()
    .getUser(uid)
    .then((u) => u.phoneNumber ?? null)
    .catch(() => null)
}

// ─── Filing a report ─────────────────────────────────────────────────────────

// Records (or merges into) the reporter's report for this match generation.
// Queue only — nothing happens to the reported account. Throws HttpsErrors
// with messages meant for the reporter.
export async function recordReport(input: {
  reporterUid: string
  reportedUid: string
  matchId: string
  generation: number
  categories: string[]
  source: string
}): Promise<void> {
  const { reporterUid, reportedUid, matchId, source } = input
  if (reportedUid === reporterUid) throw new HttpsError('invalid-argument', "You can't report yourself.")
  const categories = [...new Set(input.categories)]
  if (categories.length === 0) throw new HttpsError('invalid-argument', 'Pick what happened.')
  if (!categories.every((c) => REVIEW_TONE.get(c) === 'negative' || REPORT_ONLY_IDS.has(c))) throw new HttpsError('invalid-argument', 'Unknown report category.')

  const [reporterSnap, reportedSnap] = await Promise.all([
    db().doc(`users/${reporterUid}`).get(),
    db().doc(`users/${reportedUid}`).get(),
  ])
  if (await isSuspendedUid(reporterUid, reporterSnap.data())) throw new HttpsError('permission-denied', 'Account suspended.')
  const reported = reportedSnap.data()
  // Bots by uid only (Stage A: anyone could set isBot on their own doc before).
  if (isBotUid(reportedUid)) {
    throw new HttpsError('failed-precondition', "Curated profiles can't be reported.")
  }
  // F-070: the generation is the server's — the claimed one only if it's a
  // real match between them, else their latest — so there's one report per
  // reporter, person and match, however it's called.
  const generation = await reportGeneration(matchId, reporterUid, reportedUid, input.generation)
  if (generation === null) {
    throw new HttpsError('permission-denied', 'You can only report people you matched with.')
  }
  await takeRateLimit(reporterUid, 'report', REPORT_LIMIT).catch(() => {
    throw new HttpsError('resource-exhausted', "You've sent a lot of reports today. Our team has them — you can send more tomorrow.")
  })

  const ref = db().doc(`reports/${reporterUid}_${reportedUid}_${generation}`)
  // F-062: a Play report keeps the Play name and photo (how the reporter
  // knows them; admins can open the account from the uid).
  const play = isPlayMatchId(matchId) ? (await db().doc(`users/${reportedUid}/playProfile/data`).get()).data() : undefined
  const photos: unknown = play ? play.photoURLs : reported?.photoURLs
  const snapshotName: unknown = play ? play.playDisplayName : reported?.displayName
  const added = await db().runTransaction(async (tx) => {
    const existing = (await tx.get(ref)).data()
    const before = Array.isArray(existing?.categories) ? (existing.categories as string[]) : []
    const merged = [...new Set([...before, ...categories])]
    tx.set(
      ref,
      {
        reportId: ref.id,
        reporterUid,
        reportedUid,
        matchId,
        generation,
        categories: merged,
        // Mobile's reports carry one category; the first keeps them readable.
        category: merged[0],
        priority: merged.some((c) => URGENT.has(c)) ? 'urgent' : 'normal',
        status: 'pending',
        source,
        // Kept for the dashboard even if the account is later deleted.
        reportedSnapshot: {
          name: typeof snapshotName === 'string' ? snapshotName : '',
          ...(play ? { mode: 'play' } : {}),
          photoURL: Array.isArray(photos) && typeof photos[0] === 'string' ? photos[0] : null,
        },
        // Latest report time (mobile's field name); the first is kept apart.
        reportedAt: Date.now(),
        firstReportedAt: existing?.firstReportedAt ?? existing?.reportedAt ?? Date.now(),
        updatedAt: FieldValue.serverTimestamp(),
        resolvedAt: FieldValue.delete(),
        resolvedAction: FieldValue.delete(),
      },
      { merge: true },
    )
    // What this call added: a new report, or new categories on an open one.
    return existing?.status !== 'pending' ? categories : categories.filter((c) => !before.includes(c))
  })
  logger.info('recordReport', { source, categories, urgent: categories.some((c) => URGENT.has(c)) })
  // Admin texts (adminAlerts.ts): child safety and felt unsafe / aggressive
  // are urgent; everything else is batched. F-070: only for what's new —
  // sending the same report again doesn't text anyone — and urgent texts
  // count once per reported person per hour (aboutUid).
  if (added.length) {
    await queueAdminAlert(
      added.includes('child_safety') ? 'childSafety' : added.some((c) => URGENT.has(c)) ? 'reportUrgent' : 'reportNew',
      { subjectUid: reporterUid, aboutUid: reportedUid },
    )
  }
  // T&S Phase 2: enough independent scam reports hide the account pending review (F-074).
  if (categories.includes('scam')) await checkScamReports(reportedUid)

}

export function parseCategories(data: unknown): string[] {
  const raw = (data as Record<string, unknown> | null)?.categories
  if (!Array.isArray(raw)) throw new HttpsError('invalid-argument', 'Pick what happened.')
  return raw.filter((c): c is string => typeof c === 'string').slice(0, 24)
}

function parseGeneration(data: unknown): number {
  const g = (data as Record<string, unknown> | null)?.generation
  return typeof g === 'number' && Number.isFinite(g) && g > 0 ? Math.floor(g) : 0
}

// The reported person as the caller was shown them: a uid in Spark, a Play
// ID in Play (F-062) — mapped back to the account here. F-064/F-065: only in
// the match's own namespace; a mixed or unknown id gets the same answer as
// someone they never matched with.
async function reportedArg(data: unknown, caller: string): Promise<string> {
  const uid = await uidNamedIn(str(data, 'matchId'), str(data, 'reportedUid'))
  if (!uid || uid === caller) throw new HttpsError('permission-denied', 'You can only report people you matched with.')
  return uid
}

export const submitReport = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    await recordReport({
      reporterUid: request.auth.uid,
      reportedUid: await reportedArg(request.data, request.auth.uid),
      matchId: str(request.data, 'matchId'),
      generation: parseGeneration(request.data),
      categories: parseCategories(request.data),
      source: 'web',
    })
    return { success: true }
  },
)

// Older web clients still call this from the review modal (serious review
// flags). Now the same queue-only report path; their severity field is
// ignored — the server decides priority from the categories. Positives in the list are
// dropped; a curated profile or anything else not reportable is a quiet no-op,
// as before.
export const reportAndBan = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const categories = parseCategories(request.data).filter((c) => REVIEW_TONE.get(c) === 'negative')
    const reportedUid = await reportedArg(request.data, request.auth.uid)
    if (categories.length === 0 || isBotUid(reportedUid)) return { success: true }
    await recordReport({
      reporterUid: request.auth.uid,
      reportedUid,
      matchId: str(request.data, 'matchId'),
      generation: 0,
      categories,
      source: 'web-review',
    }).catch((err: unknown) => {
      if (err instanceof HttpsError && err.code === 'failed-precondition') return
      throw err
    })
    return { success: true }
  },
)

// ─── Admin ───────────────────────────────────────────────────────────────────

function requireAdmin(auth: { uid: string; token?: Record<string, unknown> } | undefined): string {
  if (!auth) throw new HttpsError('unauthenticated', 'Login required')
  if (!isAdminAuth(auth)) throw new HttpsError('permission-denied', 'Admins only.')
  return auth.uid
}

export type AccountStatus = 'active' | 'suspended' | 'banned' | 'deleted'

export interface ReportEntry {
  // Opaque: report ids contain the reporter's uid.
  key: string
  categories: string[]
  reportedAt: number | null
  priority: Priority
  status: ReportStatus
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
  // Distinct people with a pending report (identities never returned).
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

// Mobile's reports: a tier instead of a priority, `pending` like ours.
function priorityOf(r: DocumentData): Priority {
  if (r.priority === 'urgent' || r.priority === 'normal') return r.priority
  return typeof r.tier === 'number' && r.tier >= 2 ? 'urgent' : 'normal'
}

function statusOf(r: DocumentData): ReportStatus {
  return r.status === 'actioned' || r.status === 'cleared' ? r.status : 'pending'
}

function categoriesOf(r: DocumentData): string[] {
  if (Array.isArray(r.categories)) return r.categories.filter((c: unknown): c is string => typeof c === 'string')
  return typeof r.category === 'string' ? [r.category] : []
}

// The display name as it was before any deletion (a soft-deleted user doc
// says "Deleted User"; the recovery record keeps the original).
async function nameBeforeBan(uid: string, user: DocumentData | undefined): Promise<string> {
  if (user && user.isDeleted !== true) return typeof user.displayName === 'string' ? user.displayName : ''
  const rec = await db().collection('deletedAccounts').where('previousUid', '==', uid).limit(1).get()
  const name: unknown = rec.docs[0]?.get('displayName')
  return typeof name === 'string' ? name : ''
}

function accountStatus(user: DocumentData | undefined): AccountStatus {
  if (!user) return 'deleted'
  if (user.bannedAt != null) return 'banned'
  if (user.isDeleted === true) return 'deleted'
  if (user.isSuspended === true) return 'suspended'
  return 'active'
}

function firstPhoto(user: DocumentData | undefined): string | null {
  const p: unknown = user?.photoURLs
  return Array.isArray(p) && typeof p[0] === 'string' ? p[0] : null
}

async function joinDates(uids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < uids.length; i += 100) {
    const res = await getAuth()
      .getUsers(uids.slice(i, i + 100).map((uid) => ({ uid })))
      .catch(() => null)
    for (const u of res?.users ?? []) out.set(u.uid, new Date(u.metadata.creationTime).getTime())
  }
  return out
}

// summaryOnly: just the counts, for the Settings badge.
export const adminGetReports = onCall(
  { timeoutSeconds: 60, memory: '512MiB', invoker: 'public' },
  async (
    request,
  ): Promise<{ urgent: number; pending: number; reported?: ReportedUser[]; goodActors?: GoodActor[] }> => {
    const summaryOnly = (request.data as Record<string, unknown> | null)?.summaryOnly === true
    await requireAdminAudited(request.auth, { action: summaryOnly ? 'reports.summary' : 'reports.list' })
    const snap = await db().collection('reports').get()

    const byUser = new Map<string, DocumentData[]>()
    for (const d of snap.docs) {
      const r = d.data()
      if (typeof r.reportedUid !== 'string') continue
      const list = byUser.get(r.reportedUid) ?? []
      list.push({ ...r, _id: d.id })
      byUser.set(r.reportedUid, list)
    }
    let urgent = 0
    let pending = 0
    for (const list of byUser.values()) {
      const open = list.filter((r) => statusOf(r) === 'pending')
      if (open.length === 0) continue
      pending++
      if (open.some((r) => priorityOf(r) === 'urgent')) urgent++
    }
    if (summaryOnly) return { urgent, pending }

    const uids = [...byUser.keys()]
    const userDocs = uids.length ? await db().getAll(...uids.map((u) => db().doc(`users/${u}`))) : []
    // Account state (suspension, bans) is in userInternal (Stage 3).
    const internals = uids.length ? await db().getAll(...uids.map((u) => db().doc(`userInternal/${u}`))) : []
    const users = new Map(userDocs.map((s, i) => [s.id, s.exists ? { ...s.data(), ...(internals[i]?.data() ?? {}) } : undefined]))
    const joined = await joinDates(uids)
    const admins = await adminUids()

    const reported: ReportedUser[] = uids.map((uid) => {
      const list = byUser.get(uid) ?? []
      const user = users.get(uid)
      const open = list.filter((r) => statusOf(r) === 'pending')
      const counted = open.length > 0 ? open : list
      const counts = new Map<string, number>()
      for (const r of counted) for (const c of categoriesOf(r)) counts.set(c, (counts.get(c) ?? 0) + 1)
      const snapshot = (list.find((r) => r.reportedSnapshot)?.reportedSnapshot ?? {}) as DocumentData
      const reportTimes = list.map((r) => millis(r.reportedAt) ?? millis(r.updatedAt)).filter((t): t is number => t !== null)
      return {
        uid,
        name: (typeof user?.displayName === 'string' && user.displayName) || snapshot.name || 'Unknown',
        photoURL: firstPhoto(user) ?? (typeof snapshot.photoURL === 'string' ? snapshot.photoURL : null),
        joinedAt: joined.get(uid) ?? millis(user?.createdAt),
        status: accountStatus(user),
        suspendedUntil: millis(user?.suspendedUntil),
        priority: open.some((r) => priorityOf(r) === 'urgent') ? 'urgent' : 'normal',
        pendingCount: open.length,
        pendingReporters: new Set(open.map((r) => r.reporterUid)).size,
        totalReporters: new Set(list.map((r) => r.reporterUid)).size,
        categories: [...counts].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
        lastReportedAt: reportTimes.length ? Math.max(...reportTimes) : null,
        lastWarnedAt: millis(user?.lastWarnedAt),
        isAdmin: admins.has(uid),
        reports: list
          .map((r) => ({
            key: createHash('sha256').update(String(r._id)).digest('hex').slice(0, 12),
            categories: categoriesOf(r),
            reportedAt: millis(r.reportedAt) ?? millis(r.updatedAt),
            priority: priorityOf(r),
            status: statusOf(r),
            source: typeof r.source === 'string' ? r.source : 'mobile',
          }))
          .sort((a, b) => (b.reportedAt ?? 0) - (a.reportedAt ?? 0)),
      }
    })
    // Open child-safety reports first, then urgent pending, then pending, then
    // resolved; newest first within.
    const childSafety = (u: ReportedUser) => u.pendingCount > 0 && u.categories.some((c) => c.category === 'child_safety')
    const rank = (u: ReportedUser) => (childSafety(u) ? -1 : u.pendingCount === 0 ? 2 : u.priority === 'urgent' ? 0 : 1)
    reported.sort((a, b) => rank(a) - rank(b) || (b.lastReportedAt ?? 0) - (a.lastReportedAt ?? 0))

    const goodSnap = await db().collection('users').where('zyloveScoreTier', 'in', GOOD_TIERS).limit(100).get()
    const goodInternals = goodSnap.empty ? [] : await db().getAll(...goodSnap.docs.map((d) => db().doc(`userInternal/${d.id}`)))
    const good = goodSnap.docs.filter((d, i) => {
      const u = { ...d.data(), ...(goodInternals[i]?.data() ?? {}) }
      return !isBotUid(d.id) && u.isBot !== true && u.isSuspended !== true && u.isDeleted !== true
    })
    const scores = good.length ? await db().getAll(...good.map((d) => db().doc(`users/${d.id}/zyloveScore/current`))) : []
    const goodActors: GoodActor[] = good
      .map((d, i) => {
        const u = d.data()
        const s = scores[i]?.data()
        return {
          uid: d.id,
          name: typeof u.displayName === 'string' && u.displayName ? u.displayName : 'Member',
          photoURL: firstPhoto(u),
          tier: String(u.zyloveScoreTier),
          reviewCount: typeof s?.reviewCount === 'number' ? s.reviewCount : 0,
          positiveCount: typeof s?.positiveCount === 'number' ? s.positiveCount : 0,
          lastThankedAt: millis(u.lastThankedAt),
        }
      })
      .sort((a, b) => GOOD_TIERS.indexOf(a.tier) - GOOD_TIERS.indexOf(b.tier) || b.positiveCount - a.positiveCount)

    return { urgent, pending, reported, goodActors }
  },
)

type ModerateAction = 'warn' | 'suspend' | 'unsuspend' | 'ban' | 'unban' | 'clear' | 'thank'
const ACTIONS: readonly ModerateAction[] = ['warn', 'suspend', 'unsuspend', 'ban', 'unban', 'clear', 'thank']


// The in-app notice AdminNotice shows on their next visit until dismissed.
function notice(type: 'warning' | 'thanks', message: string) {
  return { id: randomUUID(), type, message, sentAt: FieldValue.serverTimestamp(), seenAt: null }
}

// Marks every pending report against uid as resolved by this action.
async function resolveReports(uid: string, status: 'actioned' | 'cleared', action: ModerateAction, adminUid: string): Promise<number> {
  // T&S Phase 4: evidence filed with those reports is decided the same way.
  await decideEvidenceFor(uid, status === 'actioned' ? 'actioned' : 'no_action', adminUid)
  const snap = await db().collection('reports').where('reportedUid', '==', uid).get()
  const open = snap.docs.filter((d) => statusOf(d.data()) === 'pending')
  for (let i = 0; i < open.length; i += 400) {
    const batch = db().batch()
    for (const d of open.slice(i, i + 400)) {
      batch.update(d.ref, { status, resolvedAction: action, resolvedBy: adminUid, resolvedAt: FieldValue.serverTimestamp() })
    }
    await batch.commit()
  }
  return open.length
}

// A suspension: userInternal state, sign-in disabled and sessions ended.
// `days` null = until an admin reviews it (T&S auto-suspension).
export async function suspendAccount(uid: string, days: number | null, by: string, source: 'admin' | 'trust' | 'auto_scam'): Promise<void> {
  await internalRef(uid).set(
    {
      isSuspended: true,
      suspendedAt: FieldValue.serverTimestamp(),
      suspendedUntil: days === null ? null : Timestamp.fromMillis(Date.now() + days * DAY_MS),
      suspendedBy: by,
      suspendSource: source,
      suspendedPendingReview: days === null,
      suspendedForDeletion: FieldValue.delete(),
    },
    { merge: true },
  )
  // T&S Phase 4: sign-in is refused by onBeforeSignIn (which offers an
  // appeal) rather than by disabling the Auth account; current sessions end
  // when their token next refreshes.
  await getAuth()
    .revokeRefreshTokens(uid)
    .catch((err: unknown) => {
      if ((err as { code?: string }).code !== 'auth/user-not-found') throw err
    })
}

export async function setAuthDisabled(uid: string, disabled: boolean): Promise<void> {
  try {
    await getAuth().updateUser(uid, { disabled })
    if (disabled) await getAuth().revokeRefreshTokens(uid)
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err
  }
}

export async function liftSuspension(uid: string): Promise<void> {
  await internalRef(uid).set(
    {
      isSuspended: false,
      suspendedAt: FieldValue.delete(),
      suspendedUntil: FieldValue.delete(),
      suspendedBy: FieldValue.delete(),
      suspendSource: FieldValue.delete(),
      suspendedPendingReview: FieldValue.delete(),
    },
    { merge: true },
  )
  await setAuthDisabled(uid, false)
}

export const adminModerate = onCall(
  { timeoutSeconds: 120, memory: '256MiB', invoker: 'public', secrets: [...SMS_SECRETS, ...STRIPE_SECRETS] },
  async (request): Promise<{ ok: true; resolved?: number; texted?: boolean; phoneBanned?: boolean }> => {
    const adminUid = requireAdmin(request.auth)
    const data = (request.data ?? {}) as Record<string, unknown>
    const uid = str(data, 'uid')
    const action = data.action as ModerateAction
    if (!ACTIONS.includes(action)) throw new HttpsError('invalid-argument', 'Unknown action.')
    if (isBotUid(uid)) throw new HttpsError('failed-precondition', 'Not for curated profiles.')
    if (uid === adminUid) throw new HttpsError('failed-precondition', 'Not on your own account.')
    const message =
      typeof data.message === 'string' && data.message.trim() ? data.message.trim().slice(0, MAX_MESSAGE) : null

    const ref = db().doc(`users/${uid}`)
    const root = (await ref.get()).data()
    // Root doc + account state from userInternal (Stage 3).
    const user = root ? { ...root, ...(await loadInternal(uid, root)) } : undefined
    if ((await isAdminUid(uid)) && action !== 'thank' && action !== 'clear') {
      throw new HttpsError('failed-precondition', 'Not on an admin account.')
    }
    const reason = typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim().slice(0, 300) : null
    // The audit keeps the action and its outcome, never the warning text itself.
    const log = (detail: Record<string, unknown> = {}) =>
      audit({ actor: adminUid, action: `report.${action}`, target: uid, reason, detail: { ...detail, ...(message ? { messageChars: message.length } : {}) } })

    switch (action) {
      case 'warn': {
        if (!user || user.isDeleted === true) throw new HttpsError('failed-precondition', 'That account no longer exists.')
        // The notice is the owner's alone (private/account); the timestamp is admin data (F-040).
        await accountRef(uid).set({ adminNotice: notice('warning', message ?? DEFAULT_WARNING) }, { merge: true })
        await internalRef(uid).set({ lastWarnedAt: FieldValue.serverTimestamp() }, { merge: true })
        const texted = await textAccount(uid, 'account', 'Zylove: You have an important notice about your account. Open zylove.app to read it.')
        const resolved = await resolveReports(uid, 'actioned', action, adminUid)
        await log({ texted })
        return { ok: true, resolved, texted }
      }
      case 'thank': {
        if (!user || user.isDeleted === true) throw new HttpsError('failed-precondition', 'That account no longer exists.')
        await accountRef(uid).set({ adminNotice: notice('thanks', message ?? DEFAULT_THANKS) }, { merge: true })
        await internalRef(uid).set({ lastThankedAt: FieldValue.serverTimestamp() }, { merge: true })
        const texted = await textAccount(uid, 'account', '✦ Zylove: The team left you a note. Open zylove.app to read it.')
        await log({ texted })
        return { ok: true, texted }
      }
      case 'suspend': {
        const days = data.days
        if (!SUSPEND_DAYS.includes(days as (typeof SUSPEND_DAYS)[number])) throw new HttpsError('invalid-argument', 'days must be 30, 60 or 90.')
        if (!user || user.isDeleted === true) throw new HttpsError('failed-precondition', 'That account no longer exists.')
        await suspendAccount(uid, days as number, adminUid, 'admin')
        const resolved = await resolveReports(uid, 'actioned', action, adminUid)
        await log({ days })
        return { ok: true, resolved }
      }
      case 'unsuspend': {
        if (!user || user.isDeleted === true) throw new HttpsError('failed-precondition', 'That account no longer exists.')
        await liftSuspension(uid)
        await log()
        return { ok: true }
      }
      // T&S Phase 5: a ban overturned — the phone, devices and photos come off
      // their lists. (The account itself was soft-deleted; it can be restored
      // through the normal recovery path once it's no longer marked banned.)
      case 'unban': {
        const phones = await db().collection('bannedPhones').where('uid', '==', uid).get()
        await Promise.all(phones.docs.map((d) => d.ref.delete()))
        const devices = await db().collection('bannedDevices').where('uids', 'array-contains', uid).get()
        for (const d of devices.docs) {
          const left = ((d.get('uids') ?? []) as string[]).filter((u) => u !== uid)
          if (left.length) await d.ref.update({ uids: left })
          else await d.ref.delete()
        }
        const unblocked = await unblockPhotosOf(uid)
        const rec = await db().collection('deletedAccounts').where('previousUid', '==', uid).get()
        await Promise.all(rec.docs.map((d) => d.ref.set({ banned: false }, { merge: true })))
        await internalRef(uid).set({ bannedAt: FieldValue.delete(), bannedBy: FieldValue.delete(), banScam: FieldValue.delete() }, { merge: true })
        await log({ phones: phones.size, devices: devices.size, unblockedPhotos: unblocked })
        return { ok: true }
      }
      case 'ban': {
        // The phone: from Auth, or (already deleted) the recovery record.
        let phone = await phoneOf(uid)
        if (!phone) {
          const rec = await db().collection('deletedAccounts').where('previousUid', '==', uid).limit(1).get()
          phone = rec.docs[0]?.id ?? null
        }
        if (phone) {
          await db()
            .doc(`bannedPhones/${phoneHash(phone)}`)
            .set(
              {
                phoneHash: phoneHash(phone),
                uid,
                banned: true,
                bannedAt: FieldValue.serverTimestamp(),
                bannedBy: adminUid,
                reportCount: BANNED_REPORT_COUNT,
              },
              { merge: true },
            )
        }
        // T&S Phase 1: its devices and addresses, before the soft delete
        // clears them — a new account seen on them is flagged.
        const bannedDevices = await markBannedDevices(uid)
        // T&S Phase 5: a ban for scams/fraud (the admin says so, or it was
        // reported as a scam) puts its photos on the blocklist — before the
        // soft delete removes them; kept while the ban stands.
        const reportCats = (await db().collection('reports').where('reportedUid', '==', uid).get()).docs.map((d) => categoriesOf(d.data()))
        const scamBan = data.scam === true || reportCats.some((c) => c.includes('scam'))
        // With the ban's context, recorded now — the name goes with the soft delete.
        const blocklistedPhotos = scamBan
          ? await blocklistPhotosOf(uid, adminUid, {
              name: await nameBeforeBan(uid, user),
              adminMarkedScam: data.scam === true,
              reports: reportCounts(reportCats),
            })
          : 0
        // Soft delete with the recovery record marked banned; an account
        // that's already gone just gets its recovery record marked.
        if (user && user.isDeleted !== true) await softDeleteAccount(uid, user, adminUid, { banned: true })
        else if (phone) await db().doc(`deletedAccounts/${phone}`).set({ banned: true }, { merge: true })
        if (user) await internalRef(uid).set({ bannedAt: FieldValue.serverTimestamp(), bannedBy: adminUid }, { merge: true })
        const resolved = await resolveReports(uid, 'actioned', action, adminUid)
        if (user) await internalRef(uid).set({ banScam: scamBan }, { merge: true })
        await log({ phoneBanned: phone !== null, bannedDevices, scamBan, blocklistedPhotos })
        logger.warn('adminModerate: banned', { phoneBanned: phone !== null })
        return { ok: true, resolved, phoneBanned: phone !== null }
      }
      case 'clear': {
        // Dismisses only: reports never changed the account, so nothing to undo.
        const resolved = await resolveReports(uid, 'cleared', action, adminUid)
        await log({ resolved })
        return { ok: true, resolved }
      }
    }
  },
)

// Hourly: lifts admin suspensions whose window is over.
export const liftExpiredSuspensions = onSchedule(
  { schedule: '15 * * * *', timeZone: 'America/Chicago', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    // Account state is in userInternal (Stage 3).
    const due = await db().collection('userInternal').where('suspendedUntil', '<=', Timestamp.now()).get()
    let lifted = 0
    for (const d of due.docs) {
      const u = { ...((await db().doc(`users/${d.id}`).get()).data() ?? {}), ...d.data() }
      if (u.isSuspended !== true || u.isDeleted === true || u.bannedAt != null) continue
      await liftSuspension(d.id).catch((err: unknown) =>
        logger.error('liftExpiredSuspensions failed', { message: err instanceof Error ? err.message : String(err) }),
      )
      lifted++
    }
    logger.info('liftExpiredSuspensions', { due: due.size, lifted })
  },
)
