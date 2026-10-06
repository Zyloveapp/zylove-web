import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore, type DocumentData, type DocumentReference } from 'firebase-admin/firestore'

// Where a user's non-public data lives (Stage 1a). users/{uid} is readable by
// every signed-in user (Explore, profiles, chat), so only profile fields stay
// on it. Everything else is in one of these:
//
//   userInternal/{uid}             server-only (rules: default deny). The
//                                  authoritative plan, payments, trust and
//                                  safety, counters and internal state.
//   users/{uid}/private/account    the owner can read, only the server writes:
//                                  phone (SMS consent), a read-only mirror of
//                                  the plan, pending photos, location summary.
//   users/{uid}/private/settings   the owner reads and writes (allow-listed
//                                  keys): SMS preferences, quiet hours,
//                                  photo-analysis consents.
//   users/{uid}/private/identity   the owner creates it; editable only until
//                                  identity is locked: legal name, birthday.
//   userLocations/{uid}            server-only: snapped coordinates, the
//                                  user's market (locked at first save).
//
// Reads fall back to the old root-doc fields while existing accounts are
// migrated (scripts/migrate-stage1a.mjs); after it runs the root no longer
// has them, and the rules stop clients writing them back.

const db = () => getFirestore()

export const userRef = (uid: string): DocumentReference => db().doc(`users/${uid}`)
export const internalRef = (uid: string): DocumentReference => db().doc(`userInternal/${uid}`)
export const accountRef = (uid: string): DocumentReference => db().doc(`users/${uid}/private/account`)
export const settingsRef = (uid: string): DocumentReference => db().doc(`users/${uid}/private/settings`)
export const identityRef = (uid: string): DocumentReference => db().doc(`users/${uid}/private/identity`)
export const locationRef = (uid: string): DocumentReference => db().doc(`userLocations/${uid}`)

// The plan: written to userInternal only; mirrored to private/account.
export const PLAN_FIELDS = ['subscriptionTier', 'subscriptionStatus', 'trialStartedAt', 'trialEndsAt', 'trialExpired'] as const

// Fields that used to sit on the root doc, by new home. The migration and the
// fallback reads both use these lists.
export const INTERNAL_FIELDS = [
  ...PLAN_FIELDS,
  'stripeCustomerId', 'stripeSubscriptionId', 'subscriptionUpdatedAt', 'subscriptionSource', 'subscriptionGrantedAt',
  'reportCount', 'sparkScore', 'zyloveScore', 'zylovScore', 'expoPushToken',
  'bioGenerations', 'goDeeperGenerations', 'profileReviews', 'lastSparkSmsAt', 'claimSMSSentAt', 'likesReceivedCount',
  'hasPendingPhotos', 'lastActive', 'reportTier1Count', 'reportTier2Count', 'reportTier3Count',
  // Mobile-era flags and counters (nothing on the web reads them).
  'profileViewCount', 'viewsLastSeenCount', 'likeCount', 'welcomeLikesSeeded', 'topPicksEverUnlocked',
  'topPicksUnlockedAt', 'compatibilityPopupTriggered', 'lastThresholdTriggered', 'discoveryUnlocked',
  'hasSeenHowTo', 'pushPermissionDeclined', 'onboardingFeedbackSeen',
  // Mobile-era photo-scanning flags (nothing reads them; not user settings).
  'aiPhotoScanningConsent', 'photoScanningConsent', 'photoScanningConsentAt',
] as const
export const ACCOUNT_FIELDS = ['smsConsent', 'pendingPhotoURLs', 'photoRejectedAt', 'photoRejectionReason'] as const
export const SETTINGS_FIELDS = ['smsNotifications', 'smsNotificationsEnabled', 'smsQuietHours', 'photoAnalysisConsent'] as const
export const IDENTITY_FIELDS = ['birthday'] as const
export const LOCATION_FIELDS = ['locationLat', 'locationLng', 'locationUpdatedAt'] as const
// Gone for good (no new home): geohash and the raw-GPS _location map.
// isAdmin became the admin auth claim; phoneNumber stays in Firebase Auth.
export const DROPPED_FIELDS = ['geohash', '_location', 'isAdmin', 'phoneNumber'] as const

// A doc's fields, falling back to the root doc's old copies for any of
// `fields` the new doc doesn't have yet (accounts not migrated).
function withFallback(doc: DocumentData | undefined, root: DocumentData | undefined, fields: readonly string[]): DocumentData {
  const out: DocumentData = { ...(doc ?? {}) }
  for (const f of fields) if (out[f] === undefined && root?.[f] !== undefined) out[f] = root[f]
  return out
}

// The user's server-only data (plan, counters…), root-doc fallback included.
// Pass the root doc when you already have it to save a read.
export async function loadInternal(uid: string, root?: DocumentData): Promise<DocumentData> {
  const [internal, r] = await Promise.all([internalRef(uid).get(), root ? Promise.resolve(root) : userRef(uid).get().then((s) => s.data())])
  return withFallback(internal.data(), r, INTERNAL_FIELDS)
}

export async function loadAccount(uid: string, root?: DocumentData): Promise<DocumentData> {
  const [account, r] = await Promise.all([accountRef(uid).get(), root ? Promise.resolve(root) : userRef(uid).get().then((s) => s.data())])
  return withFallback(account.data(), r, ACCOUNT_FIELDS)
}

export async function loadSettings(uid: string, root?: DocumentData): Promise<DocumentData> {
  const [settings, r] = await Promise.all([settingsRef(uid).get(), root ? Promise.resolve(root) : userRef(uid).get().then((s) => s.data())])
  return withFallback(settings.data(), r, SETTINGS_FIELDS)
}

// { lat, lng, marketCityId } or null. Root-doc coordinates as fallback.
export async function loadLocation(uid: string, root?: DocumentData): Promise<{ lat: number; lng: number; marketCityId: string | null } | null> {
  const loc = (await locationRef(uid).get()).data()
  if (typeof loc?.lat === 'number' && typeof loc?.lng === 'number') {
    return { lat: loc.lat, lng: loc.lng, marketCityId: typeof loc.marketCityId === 'string' ? loc.marketCityId : null }
  }
  const r = root ?? (await userRef(uid).get()).data()
  return typeof r?.locationLat === 'number' && typeof r?.locationLng === 'number'
    ? { lat: r.locationLat, lng: r.locationLng, marketCityId: null }
    : null
}

// ─── mirrorPlan ──────────────────────────────────────────────────────────────

// userInternal/{uid} → users/{uid}/private/account: the plan fields and
// whether there's a Stripe customer, so the app can show the user their own
// plan without being able to read (or write) userInternal.
export const mirrorPlan = onDocumentWritten({ document: 'userInternal/{uid}', memory: '256MiB' }, async (event) => {
  const before = event.data?.before.data() ?? {}
  const after = event.data?.after.data()
  const { uid } = event.params
  if (!after) return
  const changed = (f: string) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null)
  const fields = [...PLAN_FIELDS]
  const billing = typeof after.stripeCustomerId === 'string' && after.stripeCustomerId !== ''
  const billingBefore = typeof before.stripeCustomerId === 'string' && before.stripeCustomerId !== ''
  if (!fields.some(changed) && billing === billingBefore && event.data?.before.exists) return
  const mirror: DocumentData = { hasBillingAccount: billing }
  for (const f of fields) mirror[f] = after[f] === undefined ? FieldValue.delete() : after[f]
  // Only for users that exist (a stray internal doc mustn't create a profile).
  if (!(await userRef(uid).get()).exists) return
  await accountRef(uid).set(mirror, { merge: true })
  logger.info('mirrorPlan', { fields: fields.filter(changed) })
})

// ─── Admins ──────────────────────────────────────────────────────────────────

// Admins carry the custom auth claim `admin: true` (set by
// scripts/migrate-stage1a.mjs; userInternal/{uid}.admin mirrors it for server
// queries). Never a field on the public doc.
export function isAdminAuth(auth: { token?: Record<string, unknown> } | undefined): boolean {
  return auth?.token?.admin === true
}

// ─── Account deletion ────────────────────────────────────────────────────────

// Every moved or dropped field, as deletes — so an anonymised root doc keeps
// none of them (older docs may still carry copies).
export const ROOT_SCRUB: Record<string, FieldValue> = Object.fromEntries(
  [...INTERNAL_FIELDS, ...ACCOUNT_FIELDS, ...SETTINGS_FIELDS, ...IDENTITY_FIELDS, ...LOCATION_FIELDS, ...DROPPED_FIELDS].map((f) => [f, FieldValue.delete()]),
)

// The private values a deleted account's 90-day recovery record keeps.
export async function deletionView(uid: string, root: DocumentData): Promise<{ birthday: unknown; subscriptionTier: unknown; reportCount: unknown }> {
  const [internal, identity] = await Promise.all([loadInternal(uid, root), identityRef(uid).get()])
  return {
    birthday: identity.data()?.birthday ?? root.birthday ?? null,
    subscriptionTier: internal.subscriptionTier ?? 'free',
    reportCount: internal.reportCount ?? 0,
  }
}

// Removes the user's private docs, server-only record and location.
export async function clearPrivateData(uid: string): Promise<void> {
  await Promise.all([
    accountRef(uid).delete(),
    settingsRef(uid).delete(),
    identityRef(uid).delete(),
    internalRef(uid).delete(),
    locationRef(uid).delete(),
  ])
}

// Whether `uid` holds the admin claim (authoritative: Firebase Auth).
export async function isAdminUid(uid: string): Promise<boolean> {
  return (await getAuth().getUser(uid).catch(() => null))?.customClaims?.admin === true
}

// Every admin's uid, from the userInternal mirror of the claim (one query).
export async function adminUids(): Promise<Set<string>> {
  const snap = await db().collection('userInternal').where('admin', '==', true).select().get()
  return new Set(snap.docs.map((d) => d.id))
}
