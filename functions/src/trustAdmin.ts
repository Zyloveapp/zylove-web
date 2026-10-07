import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { audit, requireAdminAudited } from './audit'
import { linkedAccounts } from './devices'
import { refreshEntry } from './explore'
import { FLAG_RETENTION_MS, type Features, type Reason } from './trustScore'
import { suspendAccount } from './reports'
import { isAdminUid } from './userData'

// T&S Phase 1 — the admin trust dashboard (/admin/trust) and user directory.
// Every call is admin-only and audit-logged (audit.ts) before it returns.

const db = () => getFirestore()
const DAY_MS = 24 * 60 * 60 * 1000
const isBot = (uid: string) => /^(zbot|seed)-/.test(uid)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const ms = (v: unknown): number | null => (v instanceof Timestamp ? v.toMillis() : typeof v === 'number' ? v : null)

function uidArg(data: unknown): string {
  const uid = (data as Record<string, unknown> | null)?.uid
  if (typeof uid !== 'string' || !uid || uid.includes('/')) throw new HttpsError('invalid-argument', 'uid required')
  return uid
}

export interface TrustSummary {
  uid: string
  name: string
  photoRef: string | null
  memberSince: string | null
  score: number
  reasons: Reason[]
  status: 'open' | 'dismissed' | 'actioned'
  openedAt: number | null
  visibilityReduced: boolean
  suspended: boolean
}

async function summaries(flags: DocumentData[]): Promise<TrustSummary[]> {
  if (!flags.length) return []
  const uids = flags.map((f) => String(f.uid))
  const [roots, internals] = await Promise.all([
    db().getAll(...uids.map((u) => db().doc(`users/${u}`))),
    db().getAll(...uids.map((u) => db().doc(`userInternal/${u}`))),
  ])
  return flags.map((f, i) => {
    const r = roots[i].data() ?? {}
    const n = internals[i].data() ?? {}
    return {
      uid: String(f.uid),
      name: str(r.displayName) || 'Unknown',
      photoRef: Array.isArray(r.photoURLs) && typeof r.photoURLs[0] === 'string' ? r.photoURLs[0] : null,
      memberSince: str(r.memberSince) || null,
      score: Number(f.score ?? 0),
      reasons: (f.reasons ?? []) as Reason[],
      status: f.status,
      openedAt: ms(f.openedAt),
      visibilityReduced: n.visibilityReduced === true,
      suspended: n.isSuspended === true,
    }
  })
}

// Flagged accounts, highest risk first.
export const adminTrustQueue = onCall({ timeoutSeconds: 60, memory: '256MiB', invoker: 'public' }, async (request) => {
  const status = (request.data as Record<string, unknown> | null)?.status
  const which = status === 'dismissed' || status === 'actioned' ? status : 'open'
  await requireAdminAudited(request.auth, { action: 'trust.queue', detail: { status: which } })
  const snap = await db().collection('trustFlags').where('status', '==', which).orderBy('score', 'desc').limit(100).get()
  return { flags: await summaries(snap.docs.map((d) => d.data())) }
})

// One account: why it scored, the signals against its group, who it's
// linked to, reports and blocks, and what admins have done about it.
export const adminTrustDetail = onCall({ timeoutSeconds: 60, memory: '256MiB', invoker: 'public' }, async (request) => {
  const uid = uidArg(request.data)
  await requireAdminAudited(request.auth, { action: 'trust.detail', target: uid })
  const [profile, flag, root, internal, signals, reports, history, linked] = await Promise.all([
    db().doc(`trustProfiles/${uid}`).get(),
    db().doc(`trustFlags/${uid}`).get(),
    db().doc(`users/${uid}`).get(),
    db().doc(`userInternal/${uid}`).get(),
    db().doc(`behaviorSignals/${uid}`).get(),
    db().collection('reports').where('reportedUid', '==', uid).get(),
    db().collection('adminAudit').where('target', '==', uid).orderBy('at', 'desc').limit(25).get(),
    linkedAccounts(uid),
  ])
  if (!root.exists) throw new HttpsError('not-found', 'No such account.')
  const p = profile.data()
  const cohort = str(p?.cohort)
  const baseline = cohort ? (await db().doc(`trustBaselines/${cohort.replace('|', '_')}`).get()).data() : undefined
  const linkedDocs = linked.length
    ? await Promise.all([db().getAll(...linked.map((l) => db().doc(`users/${l.uid}`))), db().getAll(...linked.map((l) => db().doc(`trustFlags/${l.uid}`)))])
    : [[], []]
  const byCategory: Record<string, number> = {}
  const reporters = new Set<string>()
  let urgent = 0
  for (const d of reports.docs) {
    const r = d.data()
    for (const c of (r.categories ?? [r.category]) as string[]) if (c) byCategory[c] = (byCategory[c] ?? 0) + 1
    if (typeof r.reporterUid === 'string') reporters.add(r.reporterUid)
    if (r.priority === 'urgent') urgent++
  }
  const r = root.data() ?? {}
  const n = internal.data() ?? {}
  const created = typeof n.accountCreatedAt === 'number' ? n.accountCreatedAt : null
  return {
    uid,
    name: str(r.displayName) || 'Unknown',
    memberSince: str(r.memberSince) || null,
    accountAgeDays: created ? Math.floor((Date.now() - created) / DAY_MS) : null,
    photoCount: Array.isArray(r.photoURLs) ? r.photoURLs.length : 0,
    verificationStatus: str(r.verificationStatus) || 'unverified',
    isFounder: r.isFounder === true,
    visibilityReduced: n.visibilityReduced === true,
    suspended: n.isSuspended === true,
    suspendedUntil: ms(n.suspendedUntil),
    score: p?.score ?? null,
    reasons: (p?.reasons ?? []) as Reason[],
    features: (p?.features ?? null) as Features | null,
    computedAt: ms(p?.computedAt),
    cohort: cohort || null,
    cohortMedians: Object.fromEntries(Object.entries((baseline?.stats ?? {}) as Record<string, { median: number }>).map(([k, v]) => [k, v.median])),
    cohortSize: typeof baseline?.n === 'number' ? baseline.n : null,
    flag: flag.exists
      ? { status: flag.get('status'), openedAt: ms(flag.get('openedAt')), closedAt: ms(flag.get('closedAt')), closeReason: flag.get('closeReason') ?? null }
      : null,
    linked: linked.map((l, i) => ({
      uid: l.uid,
      via: l.via,
      name: str(linkedDocs[0][i]?.data()?.displayName) || 'Unknown',
      deleted: linkedDocs[0][i]?.data()?.isDeleted === true,
      flagged: linkedDocs[1][i]?.data()?.status === 'open',
      score: linkedDocs[1][i]?.data()?.score ?? null,
    })),
    reports: { total: reports.size, reporters: reporters.size, urgent, byCategory, pending: reports.docs.filter((d) => d.data().status === 'pending').length },
    blocksReceived: Number(signals.data()?.receivedBlockCount ?? 0),
    history: history.docs.map((d) => {
      const a = d.data()
      return { action: a.action, actor: a.actor, reason: a.reason ?? null, at: ms(a.at) }
    }),
  }
})

// "View profile" — what the account shows people, for review. Logged.
export const adminViewProfile = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  const uid = uidArg(request.data)
  await requireAdminAudited(request.auth, { action: 'profile.view', target: uid })
  const [root, spark] = await Promise.all([db().doc(`users/${uid}`).get(), db().doc(`users/${uid}/sparkProfile/data`).get()])
  if (!root.exists) throw new HttpsError('not-found', 'No such account.')
  const r = root.data() ?? {}
  const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))
  return {
    uid,
    profile: pick([
      'displayName', 'age', 'genderIdentity', 'bio', 'promptAnswers', 'photoURLs', 'locationLabel', 'memberSince', 'verificationStatus',
      'personalityTraits', 'relationshipValues', 'lifestyleTags', 'weekendVibes', 'habitTags', 'isFounder', 'founderBadge', 'zyloveScoreTier',
    ]),
    sparkBio: str(spark.data()?.bio) || null,
  }
})

const TRUST_ACTIONS = ['dismiss', 'reduce_visibility', 'restore_visibility', 'suspend'] as const
type TrustAction = (typeof TRUST_ACTIONS)[number]
const SUSPEND_DAYS = [30, 60, 90]

// Dismiss the flag, reduce or restore visibility, or suspend — each with a
// reason, logged. (Selfie verification requests wait for item 9.)
export const adminTrustAction = onCall({ timeoutSeconds: 60, memory: '256MiB', invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const data = (request.data ?? {}) as Record<string, unknown>
  const uid = uidArg(data)
  const action = data.action as TrustAction
  if (!TRUST_ACTIONS.includes(action)) throw new HttpsError('invalid-argument', 'Unknown action.')
  const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 500) : ''
  if (reason.length < 5) throw new HttpsError('invalid-argument', 'A reason is required.')
  const days = action === 'suspend' ? Number(data.days) : null
  if (action === 'suspend' && !SUSPEND_DAYS.includes(days as number)) throw new HttpsError('invalid-argument', 'days must be 30, 60 or 90.')
  const adminUid = await requireAdminAudited(request.auth, { action: `trust.${action}`, target: uid, reason, detail: days ? { days } : {} })
  if (isBot(uid)) throw new HttpsError('failed-precondition', 'Not for curated profiles.')
  if (uid === adminUid) throw new HttpsError('failed-precondition', 'Not on your own account.')
  if (action !== 'dismiss' && (await isAdminUid(uid))) throw new HttpsError('failed-precondition', 'Not on an admin account.')
  const root = (await db().doc(`users/${uid}`).get()).data()
  if (!root || root.isDeleted === true) throw new HttpsError('failed-precondition', 'That account no longer exists.')

  const flagRef = db().doc(`trustFlags/${uid}`)
  const close = (status: 'dismissed' | 'actioned') =>
    flagRef.set(
      {
        status,
        closedAt: FieldValue.serverTimestamp(),
        closedBy: adminUid,
        closeReason: reason,
        closeAction: action,
        expiresAt: Timestamp.fromMillis(Date.now() + FLAG_RETENTION_MS),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
  switch (action) {
    case 'dismiss':
      if (!(await flagRef.get()).exists) throw new HttpsError('failed-precondition', 'No flag to dismiss.')
      await close('dismissed')
      break
    case 'reduce_visibility':
    case 'restore_visibility':
      await db()
        .doc(`userInternal/${uid}`)
        .set(
          action === 'reduce_visibility'
            ? { visibilityReduced: true, visibilityReducedAt: FieldValue.serverTimestamp(), visibilityReducedBy: adminUid }
            : { visibilityReduced: FieldValue.delete(), visibilityReducedAt: FieldValue.delete(), visibilityReducedBy: FieldValue.delete() },
          { merge: true },
        )
      await refreshEntry(uid)
      if (action === 'reduce_visibility' && (await flagRef.get()).exists) await close('actioned')
      break
    case 'suspend':
      await suspendAccount(uid, days, adminUid, 'trust')
      await refreshEntry(uid)
      if ((await flagRef.get()).exists) await close('actioned')
      break
  }
  return { ok: true }
})

// The admin directory: by user id, phone number or name (prefix). Flagged
// accounts first. The query itself isn't logged — only its kind.
export const adminSearchUsers = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  const q = str((request.data as Record<string, unknown> | null)?.q).trim()
  if (q.length < 2) throw new HttpsError('invalid-argument', 'Type at least 2 characters.')
  const digits = q.replace(/[^\d+]/g, '')
  // A phone number; else an exact account id (any single token that names
  // an account); else a name prefix.
  const phoneLike = /^\+?[\d\s().-]{10,20}$/.test(q) && digits.replace(/\D/g, '').length >= 10
  const uidHit = !phoneLike && !/\s/.test(q) && !q.includes('/') && (await db().doc(`users/${q}`).get()).exists
  const kind = phoneLike ? 'phone' : uidHit ? 'uid' : 'name'
  const actor = await requireAdminAudited(request.auth, { action: 'directory.search', detail: { kind } })
  const uids = new Set<string>()
  if (kind === 'uid') {
    uids.add(q)
  } else if (kind === 'phone') {
    const e164 = digits.startsWith('+') ? digits : digits.length === 10 ? `+1${digits}` : `+${digits}`
    const user = await getAuth().getUserByPhoneNumber(e164).catch(() => null)
    if (user) uids.add(user.uid)
  } else {
    const lower = q.toLowerCase()
    const snap = await db().collection('userInternal').where('searchName', '>=', lower).where('searchName', '<', `${lower}`).limit(25).get()
    snap.docs.forEach((d) => uids.add(d.id))
  }
  const list = [...uids].filter((u) => !isBot(u)).slice(0, 25)
  if (!list.length) return { results: [] }
  const flags = await db().getAll(...list.map((u) => db().doc(`trustFlags/${u}`)))
  const rows = await summaries(list.map((u, i) => ({ uid: u, status: flags[i].data()?.status ?? null, score: flags[i].data()?.score ?? 0, reasons: flags[i].data()?.reasons ?? [] })))
  rows.sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.score - a.score)
  await audit({ actor, action: 'directory.results', detail: { kind, count: rows.length } })
  return { results: rows }
})
