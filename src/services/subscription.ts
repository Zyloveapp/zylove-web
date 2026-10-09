import { doc, getDoc, onSnapshot, type DocumentData, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'
import { cityById, getNearestCity, type ZyloveCity } from '../config/cities'

// Plans (Stage C): the server decides — users/{uid}/private/account
// .entitlement = { tier, source, until, cityId } (functions/src/entitlements.ts),
// and enforces every paid feature itself. This file only reads it to show
// the right screens: 'trial' and 'prelaunch' are Elite access with their own
// banners. Without a readable entitlement the app shows Free (it never
// fails open).

export type Tier = 'elite' | 'spark_plus' | 'trial' | 'prelaunch' | 'free'
export type Feature =
  | 'explore'
  | 'sparks'
  | 'compatibility'
  | 'photo_sharing'
  | 'play_mode'
  | 'zylove_score'
  | 'conversation_starters'
  | 'vibe_check'
  | 'top_picks'
  | 'curious'
  | 'deep_fit'

export interface TierFields {
  subscriptionTier?: unknown
  trialStartedAt?: unknown
  trialEndsAt?: unknown
  trialExpired?: unknown
  isFounder?: unknown
  // Stripe state, written by the stripeWebhook function.
  subscriptionStatus?: unknown
  // The user's market (locked server-side at their first saved location);
  // older accounts: the saved coordinates, which decide it.
  marketCityId?: unknown
  locationLat?: unknown
  locationLng?: unknown
  // There's a Stripe customer to manage (Settings → Membership).
  hasBillingAccount?: unknown
  // The server's decision (Stage C).
  entitlement?: unknown
}

interface ServerEntitlement {
  tier: 'free' | 'spark_plus' | 'elite'
  source: 'identity' | 'founder' | 'paid' | 'trial' | 'prelaunch' | 'waiting' | 'free'
  until: Date | null
  cityId: string | null
}

export function entitlementOf(user: TierFields): ServerEntitlement | null {
  const e = user.entitlement as Record<string, unknown> | null | undefined
  if (!e || typeof e !== 'object') return null
  const tier = e.tier === 'elite' || e.tier === 'spark_plus' ? e.tier : 'free'
  const sources = ['identity', 'founder', 'paid', 'trial', 'prelaunch', 'waiting', 'free'] as const
  const source = sources.find((x) => x === e.source) ?? 'free'
  return { tier, source, until: toDate(e.until), cityId: typeof e.cityId === 'string' ? e.cityId : null }
}

function toDate(v: unknown): Date | null {
  if (v && typeof v === 'object' && 'toDate' in v && typeof v.toDate === 'function') return v.toDate() as Date
  if (typeof v === 'number' || typeof v === 'string') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

// Complimentary Elite — by how they're matched, or as a founder (server-decided).
export function isAlwaysElite(user: TierFields): boolean {
  const e = entitlementOf(user)
  return e?.tier === 'elite' && (e.source === 'identity' || e.source === 'founder')
}

// Free until their linked city opens (no launch city near them yet).
export function waitingForCity(user: TierFields): string | null {
  const e = entitlementOf(user)
  return e?.source === 'waiting' ? e.cityId : null
}

// The server has started this user's trial (their market opened).
export function trialStarted(user: TierFields): boolean {
  return user.trialStartedAt != null
}

export function getUserTier(user: TierFields): Tier {
  const e = entitlementOf(user)
  if (!e) return 'free'
  if (e.until && e.until <= new Date()) return 'free' // a trial ends on the dot
  if (e.tier === 'elite') return e.source === 'trial' ? 'trial' : e.source === 'prelaunch' ? 'prelaunch' : 'elite'
  return e.tier
}

// The plans as sold (Upgrade page): Free — Explore, matching and chat, 10
// likes a day, the score, Vibe check, a conversation starter a week; Spark+
// adds who liked you, Top Picks, the full report and Break the ice, photos in
// chat; Elite adds Curious, the Zylove Score page, Play and Deep Fit.
const FREE: readonly Feature[] = ['explore', 'vibe_check', 'conversation_starters']
const SPARK_PLUS: readonly Feature[] = [...FREE, 'sparks', 'top_picks', 'compatibility', 'photo_sharing']
const ELITE: readonly Feature[] = [...SPARK_PLUS, 'curious', 'zylove_score', 'play_mode', 'deep_fit']
const ACCESS: Record<Tier, readonly Feature[]> = { elite: ELITE, trial: ELITE, prelaunch: ELITE, spark_plus: SPARK_PLUS, free: FREE }

export function canAccess(tier: Tier, feature: Feature): boolean {
  return ACCESS[tier].includes(feature)
}

// Whether the server says this user can see other people's Play data now
// (entitled + finished Play profile + not suspended; a trial's end applies
// on the dot). undefined: not computed yet (accounts before Stage 2).
export function hasPlayAccess(view: { playAccess?: unknown; playAccessUntil?: unknown }): boolean | undefined {
  if (view.playAccess === undefined) return undefined
  const until = toDate(view.playAccessUntil)
  return view.playAccess === true && (until === null || until > new Date())
}

// 'active' | 'past_due' | 'canceled' | 'unpaid', or null for no subscription.
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'unpaid'

export function getSubscriptionStatus(user: TierFields): SubscriptionStatus | null {
  const s = user.subscriptionStatus
  return s === 'active' || s === 'past_due' || s === 'canceled' || s === 'unpaid' ? s : null
}

// Free because a trial that actually started ran out (flagged nightly by
// checkTrialStatus, or its end date has simply passed) — not just "no plan",
// and never a pre-launch user.
export function hasTrialEnded(user: TierFields): boolean {
  if (!trialStarted(user) || getUserTier(user) !== 'free' || entitlementOf(user)?.source === 'paid') return false
  const endsAt = toDate(user.trialEndsAt)
  return user.trialExpired === true || (endsAt !== null && endsAt <= new Date())
}

export function getDaysLeftInTrial(user: TierFields): number | null {
  if (!trialStarted(user)) return null
  const endsAt = toDate(user.trialEndsAt)
  if (!endsAt) return null
  return Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000))
}

export const TRIAL_DAYS = 30

// The launch city covering the user's saved location, or null (outside
// every launch city, or no location yet).
export function marketOf(user: TierFields): ZyloveCity | null {
  const locked = cityById(user.marketCityId)
  if (locked) return locked
  return typeof user.locationLat === 'number' && typeof user.locationLng === 'number'
    ? getNearestCity(user.locationLat, user.locationLng)
    : null
}

// The pre-launch line: "Free while we build the network in Austin" (or "in
// your area" outside every launch city).
export function prelaunchLine(marketName: string | null): string {
  return `Free while we build the network in ${marketName ?? 'your area'}`
}

// "12 days left in your free trial."
export function trialDaysLine(daysLeft: number): string {
  return `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left in your free trial.`
}

// ─── The user's own account view ─────────────────────────────────────────────

// The plan lives server-side (userInternal), mirrored read-only to
// users/{uid}/private/account along with the saved location's summary. The
// public doc keeps identity and founder fields. Accounts from before the move
// still have the old copies on the public doc; those count until migrated.
const PLAN_KEYS = ['subscriptionTier', 'subscriptionStatus', 'trialStartedAt', 'trialEndsAt', 'trialExpired'] as const

export const accountDoc = (uid: string) => doc(db, 'users', uid, 'private', 'account')

export function accountView(root: DocumentData | undefined, account: DocumentData | undefined): DocumentData {
  const view: DocumentData = { ...(root ?? {}) }
  for (const k of PLAN_KEYS) if (account?.[k] !== undefined) view[k] = account[k]
  view.hasBillingAccount =
    typeof account?.hasBillingAccount === 'boolean'
      ? account.hasBillingAccount
      : typeof root?.stripeCustomerId === 'string' && root.stripeCustomerId !== ''
  const loc = account?.location
  if (loc && typeof loc === 'object') {
    view.marketCityId = loc.marketCityId ?? null
    if (typeof loc.lat === 'number' && typeof loc.lng === 'number') {
      view.locationLat = loc.lat
      view.locationLng = loc.lng
    }
    if (typeof loc.label === 'string' && loc.label) view.locationLabel = loc.label
  }
  // Founder status and the founder↔team thread summary (Stage B: off the
  // public doc; older accounts still have the root copies).
  if (account?.founderStatus !== undefined) view.founderStatus = account.founderStatus
  if (account?.founderThreadMeta !== undefined) view.founderThreadMeta = account.founderThreadMeta
  // Play access as the server decided it (Stage 2; functions/src/playAccess.ts).
  view.playEntitled = account?.playEntitled
  view.playAccess = account?.playAccess
  view.playAccessUntil = account?.playAccessUntil ?? null
  // The plan as the server decided it (Stage C).
  view.entitlement = account?.entitlement ?? null
  return view
}

// One read of the account view (public doc + private/account).
export async function loadAccountView(uid: string): Promise<DocumentData | undefined> {
  const [root, account] = await Promise.all([getDoc(doc(db, 'users', uid)), getDoc(accountDoc(uid)).catch(() => null)])
  return root.exists() ? accountView(root.data(), account?.data()) : undefined
}

// Live account view. An unreadable private/account counts as empty (the
// public doc's older copies stand in); an unreadable public doc is an error.
export function subscribeAccountView(uid: string, onChange: (view: DocumentData) => void, onError: () => void): Unsubscribe {
  let root: DocumentData | undefined
  let account: DocumentData | undefined
  let rootSeen = false
  let accountSeen = false
  const emit = () => {
    if (rootSeen && accountSeen) onChange(accountView(root, account))
  }
  const offRoot = onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      root = snap.data()
      rootSeen = true
      emit()
    },
    onError,
  )
  const offAccount = onSnapshot(
    accountDoc(uid),
    (snap) => {
      account = snap.data()
      accountSeen = true
      emit()
    },
    () => {
      account = undefined
      accountSeen = true
      emit()
    },
  )
  return () => {
    offRoot()
    offAccount()
  }
}

export function subscribeTierFields(uid: string, onChange: (fields: TierFields) => void, onError: () => void): Unsubscribe {
  return subscribeAccountView(
    uid,
    (d) =>
      onChange({
        subscriptionTier: d.subscriptionTier,
        trialStartedAt: d.trialStartedAt,
        trialEndsAt: d.trialEndsAt,
        trialExpired: d.trialExpired,
        isFounder: d.isFounder,
        subscriptionStatus: d.subscriptionStatus,
        marketCityId: d.marketCityId,
        locationLat: d.locationLat,
        locationLng: d.locationLng,
        hasBillingAccount: d.hasBillingAccount,
        // The server's decision (Stage C) — what the tier comes from.
        entitlement: d.entitlement,
      }),
    onError,
  )
}
