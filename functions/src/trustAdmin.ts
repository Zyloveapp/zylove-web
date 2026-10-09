import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { audit, requireAdmin, requireAdminAudited } from './audit'
import { linkedAccounts } from './devices'
import { refreshEntry } from './explore'
import { FLAG_RETENTION_MS, type Features, type Reason } from './trustScore'
import { liftSuspension, suspendAccount } from './reports'
import { isAdminUid } from './userData'
import { loadMatch } from './playMatch'
import { loadPlayName } from './playName'
import { signPhotoRefs } from './photoAccess'

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

// Every match the account is in, Spark and Play, newest first (up to 50 of
// each). F-062: a Play match's people are in its server-only record; admins
// see the partner's real account and Spark name, and the Play name labelled
// as such. Nothing here reaches a non-admin.
async function matchesOf(uid: string) {
  const status = (m: DocumentData) => (m.isBlocked === true ? 'blocked' : m.unmatchedAt ? 'ended' : 'active')
  const [spark, playMembers] = await Promise.all([
    db().collection('matches').where('users', 'array-contains', uid).get(),
    db().collection('playMatchMembers').where('users', 'array-contains', uid).get(),
  ])
  const rows: { matchId: string; mode: 'spark' | 'play'; otherUid: string; matchedAt: number | null; status: string }[] = []
  for (const d of spark.docs) {
    const m = d.data()
    // A chat kept for its reporter lists only them in users; both are in pairUsers.
    const other = ((m.pairUsers ?? m.users ?? []) as string[]).find((u) => u !== uid)
    if (other) rows.push({ matchId: d.id, mode: m.mode === 'play' || m.mode === 'entanglement' ? 'play' : 'spark', otherUid: other, matchedAt: ms(m.matchedAt) ?? ms(m.createdAt), status: status(m) })
  }
  for (const mem of playMembers.docs) {
    const ctx = await loadMatch(mem.id)
    const other = ctx?.otherOf(uid)
    if (ctx && other) rows.push({ matchId: mem.id, mode: 'play', otherUid: other, matchedAt: ms(ctx.data.matchedAt) ?? ms(ctx.data.createdAt), status: status(ctx.data) })
  }
  const latest = (mode: 'spark' | 'play') => rows.filter((r) => r.mode === mode).sort((a, b) => (b.matchedAt ?? 0) - (a.matchedAt ?? 0)).slice(0, 50)
  const kept = [...latest('spark'), ...latest('play')]
  const others = [...new Set(kept.map((r) => r.otherUid))]
  const docs = others.length ? await db().getAll(...others.map((u) => db().doc(`users/${u}`))) : []
  const sparkName = new Map(others.map((u, i) => [u, str(docs[i]?.data()?.displayName) || 'Unknown']))
  const playNames = new Map(await Promise.all(others.filter((u) => kept.some((r) => r.otherUid === u && r.mode === 'play')).map(async (u) => [u, await loadPlayName(u)] as const)))
  return kept
    .map((r) => ({ ...r, otherName: sparkName.get(r.otherUid) ?? 'Unknown', otherPlayName: r.mode === 'play' ? (playNames.get(r.otherUid) ?? null) : null }))
    .sort((a, b) => (b.matchedAt ?? 0) - (a.matchedAt ?? 0))
}

// One account: why it scored, the signals against its group, who it's
// linked to, reports and blocks, and what admins have done about it.
export const adminTrustDetail = onCall({ timeoutSeconds: 60, memory: '256MiB', invoker: 'public' }, async (request) => {
  const uid = uidArg(request.data)
  await requireAdminAudited(request.auth, { action: 'trust.detail', target: uid })
  const [profile, flag, root, internal, signals, reports, history, linked, traps, photoSignals, dupes, matches] = await Promise.all([
    db().doc(`trustProfiles/${uid}`).get(),
    db().doc(`trustFlags/${uid}`).get(),
    db().doc(`users/${uid}`).get(),
    db().doc(`userInternal/${uid}`).get(),
    db().doc(`behaviorSignals/${uid}`).get(),
    db().collection('reports').where('reportedUid', '==', uid).get(),
    db().collection('adminAudit').where('target', '==', uid).orderBy('at', 'desc').limit(25).get(),
    linkedAccounts(uid),
    db().collection('scamTrapHits').where('uid', '==', uid).get(),
    db().doc(`photoSignals/${uid}`).get(),
    db().collection('photoDuplicates').where('uids', 'array-contains', uid).get(),
    matchesOf(uid),
  ])
  // T&S Phase 5: the same photo on other accounts, side by side (short-lived URLs).
  const pairs = dupes.docs.map((d) => {
    const other = ((d.get('uids') ?? []) as string[]).find((u) => u !== uid) ?? ''
    const photos = ((d.get('photos') ?? []) as Record<string, string>[]).map((p) => ({ mine: p[uid] ?? '', theirs: p[other] ?? '' }))
    return { other, photos, distance: Number(d.get('distance') ?? 0), status: str(d.get('status')) }
  })
  const signed = pairs.length ? (await signPhotoRefs(pairs.flatMap((p) => p.photos.flatMap((x) => [x.mine, x.theirs])).filter(Boolean))).urls : {}
  const otherNames = pairs.length ? await db().getAll(...pairs.map((p) => db().doc(`users/${p.other}`))) : []
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
    // T&S Phase 2
    suspendedPendingReview: n.suspendedPendingReview === true,
    suspendSource: str(n.suspendSource) || null,
    // F-074: hidden from new people after scam reports, pending review.
    hiddenPendingReview: n.hiddenPendingReview ? { at: ms(n.hiddenPendingReview.at), reporters: Number(n.hiddenPendingReview.reporters ?? 0) } : null,
    countryCheck: n.countryCheck ? { ip: n.countryCheck.ip ?? null, phone: n.countryCheck.phone ?? null, city: n.countryCheck.city ?? null } : null,
    // What they sent curated profiles that matched scam patterns (excerpts only).
    scamTraps: traps.docs
      .map((d) => ({ hits: (d.get('hits') ?? []) as string[], excerpt: str(d.get('excerpt')), at: ms(d.get('at')) }))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, 20),
    duplicatePhotos: pairs.map((p, i) => ({
      otherUid: p.other,
      otherName: str(otherNames[i]?.data()?.displayName) || 'Unknown',
      distance: p.distance,
      status: p.status,
      photos: p.photos.map((x) => ({ mine: signed[x.mine] ?? null, theirs: signed[x.theirs] ?? null })),
    })),
    photoChecks: Object.values((photoSignals.data()?.photos ?? {}) as Record<string, DocumentData>).map((ph) => ({
      path: str(ph.path),
      ai: typeof ph.ai === 'number' ? ph.ai : null,
      deepfake: typeof ph.deepfake === 'number' ? ph.deepfake : null,
      web: ph.web ? { full: Number(ph.web.full ?? 0), pages: Number(ph.web.pages ?? 0), sample: (ph.web.sample ?? []) as string[] } : null,
    })),
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
    matches,
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

const TRUST_ACTIONS = ['dismiss', 'reduce_visibility', 'restore_visibility', 'suspend', 'lift_suspension'] as const
type TrustAction = (typeof TRUST_ACTIONS)[number]
const SUSPEND_DAYS = [30, 60, 90]

// Dismiss the flag, reduce or restore visibility, suspend or lift a
// suspension — each with a reason, logged. Each also ends an automatic scam
// hold (hiddenPendingReview). (Selfie verification requests wait for item 9.)
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
    // T&S Phase 2: e.g. an automatic scam suspension that review cleared.
    case 'lift_suspension':
      if ((await db().doc(`userInternal/${uid}`).get()).data()?.isSuspended !== true) throw new HttpsError('failed-precondition', 'Not suspended.')
      await liftSuspension(uid)
      await refreshEntry(uid)
      if ((await flagRef.get()).exists) await close('dismissed')
      break
  }
  // F-074: any decision here is the review an automatic scam hold waits for
  // (dismiss puts the account back in Explore; suspending hides it anyway).
  const internalRef = db().doc(`userInternal/${uid}`)
  if ((await internalRef.get()).data()?.hiddenPendingReview) {
    await internalRef.set({ hiddenPendingReview: FieldValue.delete() }, { merge: true })
    await refreshEntry(uid)
  }
  return { ok: true }
})

// The admin directory: by user id, phone number or name (prefix). Flagged
// accounts first. The query itself isn't logged — only its kind.
export const adminSearchUsers = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  // F-094: the admin check comes before anything is read.
  await requireAdmin(request.auth, 'adminSearchUsers')
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
    // A prefix: from the name up to the name followed by the highest
    // character (written as an escape — the bare character is invisible).
    const lower = q.toLowerCase()
    const snap = await db().collection('userInternal').where('searchName', '>=', lower).where('searchName', '<', `${lower}\uf8ff`).limit(25).get()
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
