import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { audit } from './audit'
import { linkedAccounts } from './devices'
import { refreshEntry } from './explore'
import { loadMatch, messagesPath } from './playMatch'
import { rescoreTrust } from './trustScore'
import { isAdminUid } from './userData'
import { queueAdminAlert } from './adminAlerts'

// T&S Phase 2 — "Report scam". Two scam reports within SCAM_WINDOW_MS from
// different people HIDE the account from new people pending review:
//   userInternal/{uid}.hiddenPendingReview = { at, source, reporters }
// (server-only) keeps it out of Explore (explore.ts); its matches and chats
// carry on, and it can still sign in. The scam_reports trust flag puts it at
// the top of /admin/trust, an urgent admin text goes out, and any admin
// action on the account there clears the hold (trustAdmin.ts).
//
// F-074: this used to SUSPEND (sign-in refused, sessions ended), and the bar
// for a reporter was low — 48 hours old and not on the reporter's device or
// IP, both of which one person with two accounts controls (device ids are
// the client's; the IP was the client's first X-Forwarded-For hop, F-073).
// Two sock puppets that matched someone could take them off the app. Now a
// wrong call costs the target only new matches until an admin looks, and
// each reporter must:
//   - be at least REPORTER_MIN_AGE_MS old,
//   - have talked with the target in the reported match: messages from both
//     sides — the target's own replies can't be made up by the reporter,
//   - not be linked to another counted reporter by device, IP or network.

export const SCAM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
export const REPORTER_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const SCAM_REPORTS_TO_HIDE = 2
const CHAT_TYPES = ['text', 'photo']

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

// Whether `id` (a uid in Spark, a Play ID in Play) sent a real chat message
// in the match — not a system one.
async function sentIn(matchId: string, id: string): Promise<boolean> {
  if (!id) return false
  const snap = await db().collection(messagesPath(matchId)).where('senderId', '==', id).limit(20).get()
  return snap.docs.some((d) => CHAT_TYPES.includes(d.get('messageType')))
}

// Whether the reporter and the target talked in any of these matches
// (the ones the reporter filed scam reports from).
async function talked(reporter: string, target: string, matchIds: string[]): Promise<boolean> {
  for (const matchId of matchIds) {
    const ctx = await loadMatch(matchId)
    if (!ctx || !ctx.users.includes(reporter) || !ctx.users.includes(target)) continue
    const [mine, theirs] = await Promise.all([sentIn(matchId, ctx.idOf(reporter)), sentIn(matchId, ctx.idOf(target))])
    if (mine && theirs) return true
  }
  return false
}

// The qualifying reporters: old enough, talked with the target, and pairwise
// unlinked. Pure apart from the lookups, so the rule is easy to read and test.
export function independentReporters(
  reporters: string[],
  created: Map<string, number>,
  linkedTo: Map<string, Set<string>>,
  conversed: Set<string>,
  now = Date.now(),
): string[] {
  const eligible = reporters.filter((r) => {
    const at = created.get(r)
    return at !== undefined && now - at >= REPORTER_MIN_AGE_MS && conversed.has(r)
  })
  // Greedy: keep a reporter only if not linked (either way) to one kept.
  const kept: string[] = []
  for (const r of eligible) {
    if (kept.some((k) => linkedTo.get(r)?.has(k) || linkedTo.get(k)?.has(r))) continue
    kept.push(r)
  }
  return kept
}

export async function checkScamReports(uid: string): Promise<boolean> {
  if (isBot(uid) || (await isAdminUid(uid))) return false
  const internal = (await db().doc(`userInternal/${uid}`).get()).data() ?? {}
  if (internal.isSuspended === true || internal.hiddenPendingReview) return false
  const now = Date.now()
  const snap = await db().collection('reports').where('reportedUid', '==', uid).get()
  const matchesBy = new Map<string, string[]>()
  for (const r of snap.docs.map((d) => d.data() as DocumentData)) {
    const cats = Array.isArray(r.categories) ? (r.categories as string[]) : [r.category]
    const at = num(r.reportedAt) || (r.updatedAt instanceof Timestamp ? r.updatedAt.toMillis() : 0)
    if (!cats.includes('scam') || now - at > SCAM_WINDOW_MS || typeof r.reporterUid !== 'string') continue
    const ids = matchesBy.get(r.reporterUid) ?? []
    if (typeof r.matchId === 'string' && !ids.includes(r.matchId)) ids.push(r.matchId)
    matchesBy.set(r.reporterUid, ids)
  }
  const reporters = [...matchesBy.keys()]
  if (reporters.length < SCAM_REPORTS_TO_HIDE) return false
  const [created, links, chats] = await Promise.all([
    createdAt(reporters),
    Promise.all(reporters.map((r) => linkedAccounts(r, { networks: true }))),
    Promise.all(reporters.map((r) => talked(r, uid, matchesBy.get(r) ?? []))),
  ])
  const linkedTo = new Map(reporters.map((r, i) => [r, new Set(links[i].map((l) => l.uid))]))
  const conversed = new Set(reporters.filter((_, i) => chats[i]))
  const independent = independentReporters(reporters, created, linkedTo, conversed, now)
  if (independent.length < SCAM_REPORTS_TO_HIDE) {
    logger.info('scamReports: not enough independent reporters', { reporters: reporters.length, independent: independent.length })
    return false
  }
  await db()
    .doc(`userInternal/${uid}`)
    .set({ hiddenPendingReview: { at: now, source: 'scam_reports', reporters: independent.length } }, { merge: true })
  await refreshEntry(uid)
  await audit({
    actor: 'system',
    action: 'trust.auto_hide',
    target: uid,
    reason: `Reported as a scam by ${independent.length} unlinked accounts that had talked with them, within 30 days — hidden from new people pending review`,
    detail: { reporters: independent.length },
  })
  // The flag (scam_reports reason) puts it at the top of the review queue.
  await rescoreTrust(uid)
  await queueAdminAlert('scamSuspend')
  logger.warn('scamReports: account hidden pending review', { reporters: independent.length })
  return true
}
