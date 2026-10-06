import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { getStorage } from 'firebase-admin/storage'
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
// Stage 2: owner-only profile metadata that would reveal Play use.
export const profileRef = (uid: string): DocumentReference => db().doc(`users/${uid}/private/profile`)

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

// Stage 2 (Play sealing). Play profile fields move to playProfile/data;
// metadata that reveals Play use (which modes, the current mode, Play-leaning
// intentions) to the owner-only private/profile.
export const PLAY_ROOT_FIELDS = [
  'playDisplayName', 'playDisplayNameUpdatedAt', 'playVisibility', 'spiceLevel', 'playInterestTags', 'playNonNegotiables',
  'playBio', 'playPromptAnswers', 'playGoDeeper', 'typePreferences', 'playBodyType', 'playHeight', 'playBodyHair',
  'playGrooming', 'playEnergy', 'playStyle', 'playPassExpiresAt', 'openToCrossover',
] as const
export const PRIVATE_PROFILE_FIELDS = ['intent', 'onboardingPath', 'mode', 'intentionAnswers'] as const

// The owner's private profile metadata, root-doc copies as fallback.
export async function loadPrivateProfile(uid: string, root?: DocumentData): Promise<DocumentData> {
  const [p, r] = await Promise.all([profileRef(uid).get(), root ? Promise.resolve(root) : userRef(uid).get().then((s) => s.data())])
  return withFallback(p.data(), r, PRIVATE_PROFILE_FIELDS)
}

// A root doc with the private profile metadata merged back in — for scoring,
// which compares intents, server-side only.
export async function withPrivateProfile(uid: string, root: DocumentData): Promise<DocumentData> {
  return { ...root, ...(await loadPrivateProfile(uid, root)) }
}

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
  // The plan, and (Stage 2) the Play flags — so the app knows its own Play access.
  const fields = [...PLAN_FIELDS, 'playEntitled', 'playAccess', 'playAccessUntil']
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
  [...INTERNAL_FIELDS, ...ACCOUNT_FIELDS, ...SETTINGS_FIELDS, ...IDENTITY_FIELDS, ...LOCATION_FIELDS, ...DROPPED_FIELDS, ...PLAY_ROOT_FIELDS, ...PRIVATE_PROFILE_FIELDS].map((f) => [f, FieldValue.delete()]),
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

// Everything Play of a deleted account (Stage 2): the Play profile and PIN,
// Play photos, Play pair scores, Play likes they sent (in the other person's
// queue) and received (in their own), and their Play name and photo on the
// other person's Play match records. The other person's own data — the
// conversation, their likes — stays. Called by every delete path
// (clearPrivateData).
export async function removePlayData(uid: string): Promise<void> {
  const firestore = db()
  const [pairsA, pairsB, ownQueue, matches] = await Promise.all([
    firestore.collection('pairs').where('userA', '==', uid).get(),
    firestore.collection('pairs').where('userB', '==', uid).get(),
    firestore.collection(`users/${uid}/likeQueue`).where('mode', '==', 'play').get(),
    firestore.collection('matches').where('users', 'array-contains', uid).where('mode', '==', 'play').get(),
  ])
  const refs: DocumentReference[] = [
    firestore.doc(`users/${uid}/playProfile/data`),
    firestore.doc(`users/${uid}/settings/playPin`),
    // Holds the Play visibility and pause time (with Spark's).
    firestore.doc(`users/${uid}/settings/pause`),
    ...ownQueue.docs.map((d) => d.ref),
  ]
  for (const p of [...pairsA.docs, ...pairsB.docs]) {
    refs.push(firestore.doc(`pairs/${p.id}/modes/play`))
    const other = p.get('userA') === uid ? p.get('userB') : p.get('userA')
    if (typeof other === 'string') {
      const sent = firestore.doc(`users/${other}/likeQueue/${uid}`)
      if ((await sent.get()).get('mode') === 'play') refs.push(sent)
    }
  }
  for (let i = 0; i < refs.length; i += 400) {
    const batch = firestore.batch()
    for (const r of refs.slice(i, i + 400)) batch.delete(r)
    await batch.commit()
  }
  for (const m of matches.docs) {
    await m.ref.update({
      [`participantSnapshots.${uid}.displayName`]: 'Deleted User',
      [`participantSnapshots.${uid}.photoURL`]: null,
    })
  }
  await getStorage()
    .bucket()
    .deleteFiles({ prefix: `photos/${uid}/play/` })
    .catch((err) => logger.warn('removePlayData: Storage delete failed', { message: String(err) }))
}

// Removes the user's private docs, server-only record, location and (Stage 2)
// all their Play data.
export async function clearPrivateData(uid: string): Promise<void> {
  await removePlayData(uid)
  await Promise.all([
    accountRef(uid).delete(),
    settingsRef(uid).delete(),
    identityRef(uid).delete(),
    profileRef(uid).delete(),
    internalRef(uid).delete(),
    locationRef(uid).delete(),
    db().doc(`rateLimits/${uid}`).delete(),
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
