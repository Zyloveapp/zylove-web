// Admin activity dashboard (/admin/activity): account, engagement,
// conversion and revenue stats, a filterable user table, a 30-day chart and
// a city breakdown — computed in one pass over real (non-bot) users, their
// profiles, matches and messages. Fine at launch scale; past a few thousand
// users this wants stored counters instead of full reads.
//
// adminUserAction runs the table's row actions (make founder, suspend,
// delete). Both check users/{uid}.isAdmin.

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { getNearestCity } from './cities'
import { claimFounderSpot, type FounderResult } from './founders'
import { revokeFounderStatus } from './founderActivity'
import { SMS_SECRETS } from './sms'

const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 25
const CHART_DAYS = 30
const TZ = 'America/Chicago'
const BOT_PREFIX = 'zbot-'
// Same list as initUserDefaults / subscription.ts: complimentary Elite.
const ELITE_IDENTITIES = new Set(['woman', 'trans_woman', 'nonbinary', 'non_binary', 'genderfluid', 'agender', 'self_describe'])

async function requireAdmin(uid: string | undefined): Promise<string> {
  if (!uid) throw new HttpsError('unauthenticated', 'Login required')
  const snap = await getFirestore().doc(`users/${uid}`).get()
  if (snap.data()?.isAdmin !== true) throw new HttpsError('permission-denied', 'Admins only.')
  return uid
}

// createdAt / lastActive are a Timestamp (mobile) or epoch ms (web).
function ms(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis()
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  return null
}

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
const dayKey = (t: number) => dayKeyFormat.format(t) // YYYY-MM-DD in Central time

export type Tier = 'founder' | 'elite' | 'spark_plus' | 'trial' | 'free'
export type Mode = 'spark' | 'play' | 'both' | 'none'
export type Status = 'active' | 'hidden' | 'suspended' | 'deleted'
const TIER_ORDER: Tier[] = ['founder', 'elite', 'spark_plus', 'trial', 'free']

export interface UserRow {
  uid: string
  name: string
  gender: string
  city: string
  joinedAt: number | null
  lastActiveAt: number | null
  onboarded: boolean
  mode: Mode
  tier: Tier
  paying: boolean
  messages: number
  matches: number
  status: Status
}

export interface ActivityRequest {
  page?: number
  mode?: 'all' | 'spark' | 'play' | 'both'
  tier?: 'all' | Tier
  activity?: 'all' | 'today' | 'week' | 'inactive7'
  city?: string // 'all' or a city name from the response
  sort?: 'newest' | 'last_active' | 'messages' | 'tier'
}

export interface ActivityResponse {
  stats: {
    accounts: { total: number; today: number; week: number; month: number }
    engagement: { activeToday: number; activeWeek: number; totalMessages: number }
    conversion: { onboarded: number; sparkProfiles: number; playProfiles: number; founders: number }
    revenue: { sparkPlusPaying: number; elitePaying: number; trialActive: number; trialExpired: number }
  }
  rows: UserRow[]
  total: number
  page: number
  pageCount: number
  cities: string[]
  chart: { days: string[]; signups: number[]; active: number[] }
  geo: { city: string; users: number; founders: number; sparkPlus: number; lastSignupAt: number | null }[]
  generatedAt: number
}

function tierOf(u: DocumentData, now: number): Tier {
  if (u.isFounder === true) return 'founder'
  const g = Array.isArray(u.genderIdentity) ? u.genderIdentity[0] : u.genderIdentity
  if (u.subscriptionTier === 'elite' || (typeof g === 'string' && ELITE_IDENTITIES.has(g))) return 'elite'
  if (u.subscriptionTier === 'spark_plus') return 'spark_plus'
  const ends = ms(u.trialEndsAt)
  if (u.trialExpired !== true && ends !== null && ends > now) return 'trial'
  return 'free'
}

function statusOf(u: DocumentData): Status {
  if (u.isDeleted === true) return 'deleted'
  if (u.isSuspended === true) return 'suspended'
  const hidden = (v: unknown) => v === 'hidden' || v === 'paused'
  return hidden(u.sparkVisibility) && hidden(u.playVisibility) ? 'hidden' : 'active'
}

function genderOf(u: DocumentData): string {
  const g = Array.isArray(u.genderIdentity) ? u.genderIdentity[0] : u.genderIdentity
  return typeof g === 'string' && g ? g.replace(/_/g, ' ') : '—'
}

// Launch city by coordinates, else the label's city, else Unknown.
function cityOf(u: DocumentData): string {
  if (typeof u.locationLat === 'number' && typeof u.locationLng === 'number') {
    const c = getNearestCity(u.locationLat, u.locationLng)
    if (c) return c.name
  }
  const label = typeof u.locationLabel === 'string' ? u.locationLabel.split(',')[0]?.trim() : ''
  return label || 'Unknown'
}

export const adminGetActivity = onCall(
  { timeoutSeconds: 120, memory: '512MiB', invoker: 'public' },
  async (request): Promise<ActivityResponse> => {
    await requireAdmin(request.auth?.uid)
    const req = (request.data ?? {}) as ActivityRequest
    const db = getFirestore()
    const now = Date.now()

    const [users, sparkDocs, playDocs, messages, matches, signals] = await Promise.all([
      db.collection('users').get(),
      db.collectionGroup('sparkProfile').select().get(),
      db.collectionGroup('playProfile').select().get(),
      db.collectionGroup('messages').select('senderId', 'sentAt', 'messageType', 'nonce').get(),
      db.collection('matches').select('users').get(),
      db.collection('behaviorSignals').select('matchCount').get(),
    ])

    // users/{uid}/<sub>/data → uid
    const owners = (docs: FirebaseFirestore.QuerySnapshot) =>
      new Set(docs.docs.filter((d) => d.id === 'data').map((d) => d.ref.parent.parent?.id ?? ''))
    const hasSpark = owners(sparkDocs)
    const hasPlay = owners(playDocs)

    // Real chat messages only (not consent/system notes, not founder threads).
    const sentBy = new Map<string, number>()
    const activeDays = new Map<string, Set<string>>()
    const markActive = (day: string, uid: string) => {
      if (!activeDays.has(day)) activeDays.set(day, new Set())
      activeDays.get(day)!.add(uid)
    }
    let totalMessages = 0
    for (const m of messages.docs) {
      if (m.ref.parent.parent?.parent.id !== 'matches') continue
      const d = m.data()
      if (d.nonce === 'system' || d.messageType === 'consent_request' || typeof d.senderId !== 'string') continue
      totalMessages++
      sentBy.set(d.senderId, (sentBy.get(d.senderId) ?? 0) + 1)
      const at = ms(d.sentAt)
      if (at !== null && now - at <= CHART_DAYS * DAY_MS) markActive(dayKey(at), d.senderId)
    }
    const matchesOf = new Map<string, number>()
    for (const m of matches.docs) {
      const us: unknown = m.data().users
      if (Array.isArray(us)) for (const u of us) if (typeof u === 'string') matchesOf.set(u, (matchesOf.get(u) ?? 0) + 1)
    }
    const signalMatches = new Map(signals.docs.map((d) => [d.id, d.data().matchCount]))

    const todayKey = dayKey(now)
    const rows: UserRow[] = []
    const stats: ActivityResponse['stats'] = {
      accounts: { total: 0, today: 0, week: 0, month: 0 },
      engagement: { activeToday: 0, activeWeek: 0, totalMessages },
      conversion: { onboarded: 0, sparkProfiles: 0, playProfiles: 0, founders: 0 },
      revenue: { sparkPlusPaying: 0, elitePaying: 0, trialActive: 0, trialExpired: 0 },
    }
    const signupsByDay = new Map<string, number>()
    const geo = new Map<string, { users: number; founders: number; sparkPlus: number; lastSignupAt: number | null }>()

    for (const doc of users.docs) {
      if (doc.id.startsWith(BOT_PREFIX)) continue
      const u = doc.data()
      const joinedAt = ms(u.createdAt)
      const lastActiveAt = ms(u.lastActive)
      const tier = tierOf(u, now)
      const status = statusOf(u)
      const paying = u.subscriptionStatus === 'active' || u.subscriptionStatus === 'past_due'
      const spark = hasSpark.has(doc.id) || (u.onboardingPath !== 'play' && Array.isArray(u.photoURLs) && u.photoURLs.length > 0)
      const play = hasPlay.has(doc.id)
      const city = cityOf(u)

      stats.accounts.total++
      if (joinedAt !== null) {
        if (dayKey(joinedAt) === todayKey) stats.accounts.today++
        if (now - joinedAt <= 7 * DAY_MS) stats.accounts.week++
        if (now - joinedAt <= 30 * DAY_MS) stats.accounts.month++
        if (now - joinedAt <= CHART_DAYS * DAY_MS) signupsByDay.set(dayKey(joinedAt), (signupsByDay.get(dayKey(joinedAt)) ?? 0) + 1)
      }
      if (status !== 'deleted') {
        if (lastActiveAt !== null && now - lastActiveAt <= DAY_MS) stats.engagement.activeToday++
        if (lastActiveAt !== null && now - lastActiveAt <= 7 * DAY_MS) stats.engagement.activeWeek++
        if (lastActiveAt !== null && now - lastActiveAt <= CHART_DAYS * DAY_MS) markActive(dayKey(lastActiveAt), doc.id)
        if (u.onboardingComplete === true) stats.conversion.onboarded++
        if (spark) stats.conversion.sparkProfiles++
        if (play) stats.conversion.playProfiles++
        if (u.isFounder === true) stats.conversion.founders++
        if (paying && u.subscriptionTier === 'spark_plus') stats.revenue.sparkPlusPaying++
        if (paying && u.subscriptionTier === 'elite') stats.revenue.elitePaying++
        if (tier === 'trial') stats.revenue.trialActive++
        const ends = ms(u.trialEndsAt)
        if (tier === 'free' && (u.trialExpired === true || (ends !== null && ends <= now))) stats.revenue.trialExpired++

        const g = geo.get(city) ?? { users: 0, founders: 0, sparkPlus: 0, lastSignupAt: null }
        g.users++
        if (u.isFounder === true) g.founders++
        if (u.subscriptionTier === 'spark_plus') g.sparkPlus++
        if (joinedAt !== null && (g.lastSignupAt === null || joinedAt > g.lastSignupAt)) g.lastSignupAt = joinedAt
        geo.set(city, g)
      }

      const signal = signalMatches.get(doc.id)
      rows.push({
        uid: doc.id,
        name: typeof u.displayName === 'string' && u.displayName.trim() ? u.displayName.trim() : '(no name)',
        gender: genderOf(u),
        city,
        joinedAt,
        lastActiveAt,
        onboarded: u.onboardingComplete === true,
        mode: spark && play ? 'both' : spark ? 'spark' : play ? 'play' : 'none',
        tier,
        paying,
        messages: sentBy.get(doc.id) ?? 0,
        matches: typeof signal === 'number' ? signal : (matchesOf.get(doc.id) ?? 0),
        status,
      })
    }

    // ─── Table: filter, sort, page ───────────────────────────────────────────
    const filtered = rows.filter((r) => {
      if (req.mode && req.mode !== 'all' && r.mode !== req.mode) return false
      if (req.tier && req.tier !== 'all' && r.tier !== req.tier) return false
      if (req.city && req.city !== 'all' && r.city !== req.city) return false
      const idle = r.lastActiveAt === null ? Infinity : now - r.lastActiveAt
      if (req.activity === 'today' && idle > DAY_MS) return false
      if (req.activity === 'week' && idle > 7 * DAY_MS) return false
      if (req.activity === 'inactive7' && idle <= 7 * DAY_MS) return false
      return true
    })
    const desc = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity)
    const sorters: Record<NonNullable<ActivityRequest['sort']>, (a: UserRow, b: UserRow) => number> = {
      newest: (a, b) => desc(a.joinedAt, b.joinedAt),
      last_active: (a, b) => desc(a.lastActiveAt, b.lastActiveAt),
      messages: (a, b) => b.messages - a.messages || desc(a.lastActiveAt, b.lastActiveAt),
      tier: (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || desc(a.joinedAt, b.joinedAt),
    }
    filtered.sort(sorters[req.sort ?? 'newest'] ?? sorters.newest)
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
    const page = Math.min(Math.max(0, Math.floor(req.page ?? 0)), pageCount - 1)

    // ─── Chart: last 30 days, oldest first ───────────────────────────────────
    const days: string[] = []
    for (let i = CHART_DAYS - 1; i >= 0; i--) days.push(dayKey(now - i * DAY_MS))
    const uniqueDays = [...new Set(days)]

    const geoRows = [...geo.entries()]
      .map(([city, g]) => ({ city, ...g }))
      .sort((a, b) => b.users - a.users || a.city.localeCompare(b.city))

    return {
      stats,
      rows: filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
      total: filtered.length,
      page,
      pageCount,
      cities: geoRows.map((g) => g.city),
      chart: {
        days: uniqueDays,
        signups: uniqueDays.map((d) => signupsByDay.get(d) ?? 0),
        active: uniqueDays.map((d) => activeDays.get(d)?.size ?? 0),
      },
      geo: geoRows,
      generatedAt: now,
    }
  },
)

// ─── Row actions ─────────────────────────────────────────────────────────────

type UserAction = 'make_founder' | 'suspend' | 'unsuspend' | 'delete'
const ACTIONS: readonly UserAction[] = ['make_founder', 'suspend', 'unsuspend', 'delete']

// make_founder: the normal founder claim at their saved location (so only
//   within a launch city, onboarded, with a spot open in their half).
// suspend / unsuspend: isSuspended, which hides them everywhere.
// delete: the same soft delete as the mobile deleteAccount (recovery doc
//   when there's a phone, anonymized user doc, Auth removed), after
//   releasing any founder spot — it then shows in the deletion queue.
export const adminUserAction = onCall(
  { timeoutSeconds: 120, memory: '256MiB', invoker: 'public', secrets: SMS_SECRETS },
  async (request): Promise<{ ok: true; founder?: FounderResult }> => {
    const adminUid = await requireAdmin(request.auth?.uid)
    const { uid, action } = (request.data ?? {}) as { uid?: unknown; action?: unknown }
    if (typeof uid !== 'string' || !uid || uid.includes('/')) throw new HttpsError('invalid-argument', 'uid required')
    if (!ACTIONS.includes(action as UserAction)) throw new HttpsError('invalid-argument', 'unknown action')
    if (uid.startsWith(BOT_PREFIX)) throw new HttpsError('failed-precondition', 'Not for bots.')
    if (uid === adminUid && action !== 'make_founder') throw new HttpsError('failed-precondition', "Not on your own account.")

    const db = getFirestore()
    const ref = db.doc(`users/${uid}`)
    const user = (await ref.get()).data()
    if (!user) throw new HttpsError('not-found', 'No such user.')
    if (user.isAdmin === true && action !== 'make_founder') throw new HttpsError('failed-precondition', 'Not on an admin account.')
    const log = (details: Record<string, unknown> = {}) =>
      db.collection('adminActions').add({ action, uid, adminUid, at: FieldValue.serverTimestamp(), ...details })

    if (action === 'make_founder') {
      if (typeof user.locationLat !== 'number' || typeof user.locationLng !== 'number') {
        return { ok: true, founder: { eligible: false, reason: 'outside_coverage' } }
      }
      const founder = await claimFounderSpot(uid, user.locationLat, user.locationLng, 'adminMakeFounder')
      await log({ result: founder.eligible ? 'assigned' : founder.reason })
      return { ok: true, founder }
    }

    if (action === 'suspend' || action === 'unsuspend') {
      const suspend = action === 'suspend'
      await ref.update(
        suspend
          ? { isSuspended: true, suspendedAt: FieldValue.serverTimestamp(), suspendedBy: adminUid }
          : { isSuspended: false, suspendedAt: FieldValue.delete(), suspendedBy: FieldValue.delete() },
      )
      await log()
      return { ok: true }
    }

    // delete
    if (user.isDeleted === true) throw new HttpsError('failed-precondition', 'Already deleted.')
    await revokeFounderStatus(uid).catch(() => null)
    const phone = await getAuth()
      .getUser(uid)
      .then((a) => a.phoneNumber ?? null)
      .catch(() => null)
    const now = Timestamp.now()
    if (phone) {
      const [asA, asB] = await Promise.all([
        db.collection('pairs').where('userA', '==', uid).get(),
        db.collection('pairs').where('userB', '==', uid).get(),
      ])
      await db.collection('deletedAccounts').doc(phone).set({
        phoneNumber: phone,
        previousUid: uid,
        deletedAt: now,
        birthday: user.birthday ?? null,
        genderIdentity: user.genderIdentity ?? null,
        matchableAs: user.matchableAs ?? [],
        identityLockedAt: user.identityLockedAt ?? null,
        pronouns: user.pronouns ?? null,
        genderSelfDescribe: user.genderSelfDescribe ?? null,
        displayName: user.displayName ?? '',
        photoURLs: user.photoURLs ?? [],
        bio: user.bio ?? '',
        mode: user.mode ?? 'spark',
        isFounder: false,
        subscriptionTier: user.subscriptionTier ?? 'free',
        reportCount: user.reportCount ?? 0,
        banned: false,
        previousPairIds: [...asA.docs, ...asB.docs].map((d) => d.id),
        deletedByAdmin: adminUid,
      })
    }
    await ref.update({
      deleted: true,
      isDeleted: true,
      deletedAt: now,
      isSuspended: true,
      displayName: 'Deleted User',
      bio: '',
      photoURLs: [],
      visible: false,
      isVisible: false,
      geohash: '',
      locationLabel: '',
    })
    await getAuth()
      .deleteUser(uid)
      .catch((err: { code?: string }) => {
        if (err.code !== 'auth/user-not-found') throw err
      })
    await log({ recoveryRecord: phone !== null })
    logger.info('adminUserAction: deleted', { recoveryRecord: phone !== null })
    return { ok: true }
  },
)
