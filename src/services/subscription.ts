import { doc, getDoc, onSnapshot, type DocumentData, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'
import { cityById, getNearestCity, type ZyloveCity } from '../config/cities'

// Web tier logic. Women and other non-male identities, and founders, are
// Elite for life. Everyone else is free while the network builds in their
// city ('prelaunch': no trialStartedAt). When discovery opens in their
// market, the server starts a 30-day trial (functions/src/trial.ts), then
// Free until they pay. Mobile still only treats woman / trans_woman as
// Elite — web is the launch surface.

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

export interface TierFields {
  subscriptionTier?: unknown
  trialStartedAt?: unknown
  trialEndsAt?: unknown
  trialExpired?: unknown
  genderIdentity?: unknown
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
}

// Stored as 'nonbinary'; 'non_binary' accepted too.
const ALWAYS_ELITE_IDENTITIES = ['woman', 'trans_woman', 'nonbinary', 'non_binary', 'genderfluid', 'agender', 'self_describe']

function toDate(v: unknown): Date | null {
  if (v && typeof v === 'object' && 'toDate' in v && typeof v.toDate === 'function') return v.toDate() as Date
  if (typeof v === 'number' || typeof v === 'string') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

function gender(user: TierFields): string {
  const g = Array.isArray(user.genderIdentity) ? user.genderIdentity[0] : user.genderIdentity
  return typeof g === 'string' ? g : ''
}

// Complimentary Elite by gender identity (founders aside).
export function hasEliteIdentity(user: TierFields): boolean {
  return ALWAYS_ELITE_IDENTITIES.includes(gender(user))
}

export function isAlwaysElite(user: TierFields): boolean {
  return hasEliteIdentity(user) || user.isFounder === true
}

// The server has started this user's trial (their market opened).
export function trialStarted(user: TierFields): boolean {
  return user.trialStartedAt != null
}

export function getUserTier(user: TierFields): Tier {
  if (isAlwaysElite(user)) return 'elite'
  if (user.subscriptionTier === 'elite') return 'elite'
  if (user.subscriptionTier === 'spark_plus') return 'spark_plus'
  // No trial yet: their market hasn't opened.
  if (!trialStarted(user)) return 'prelaunch'
  const endsAt = toDate(user.trialEndsAt)
  if (user.trialExpired !== true && endsAt && endsAt > new Date()) return 'trial'
  return 'free'
}

const ACCESS: Record<Tier, readonly Feature[]> = {
  elite: ['explore', 'sparks', 'compatibility', 'photo_sharing', 'play_mode', 'zylove_score', 'conversation_starters', 'vibe_check'],
  spark_plus: ['explore', 'sparks', 'compatibility', 'photo_sharing', 'conversation_starters', 'vibe_check'],
  trial: ['explore', 'sparks', 'compatibility', 'photo_sharing', 'play_mode', 'zylove_score', 'conversation_starters', 'vibe_check'],
  // Free while the network builds: everything a trial gets.
  prelaunch: ['explore', 'sparks', 'compatibility', 'photo_sharing', 'play_mode', 'zylove_score', 'conversation_starters', 'vibe_check'],
  free: ['explore'],
}

export function canAccess(tier: Tier, feature: Feature): boolean {
  return ACCESS[tier].includes(feature)
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
  if (!trialStarted(user) || getUserTier(user) !== 'free') return false
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
        genderIdentity: d.genderIdentity,
        isFounder: d.isFounder,
        subscriptionStatus: d.subscriptionStatus,
        marketCityId: d.marketCityId,
        locationLat: d.locationLat,
        locationLng: d.locationLng,
        hasBillingAccount: d.hasBillingAccount,
      }),
    onError,
  )
}
