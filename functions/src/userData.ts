import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { getStorage } from 'firebase-admin/storage'
import { removeDeviceData } from './devices'
import { removePhotoHashes } from './photoHashes'
import { FieldValue, Timestamp, getFirestore, type DocumentData, type DocumentReference } from 'firebase-admin/firestore'

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
// Stage 3: owner-only matching preferences (Explore and scoring read them server-side).
export const matchingRef = (uid: string): DocumentReference => db().doc(`users/${uid}/private/matching`)

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
  // Stage 3: suspension, bans and pending deletion (account state). The
  // public doc keeps only isDeleted (the rules hide deleted profiles by it).
  'isSuspended', 'suspendedAt', 'suspendedUntil', 'suspendedBy', 'suspendSource', 'suspendReason',
  'suspendedPendingReview', 'bannedAt', 'bannedBy', 'deletionRequestedAt', 'deletionScheduledFor', 'deletionReason',
  'lastWarnedAt', 'lastThankedAt',
] as const
export const ACCOUNT_FIELDS = ['smsConsent', 'pendingPhotoURLs', 'photoRejectedAt', 'photoRejectionReason', 'adminNotice'] as const
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

// Stage 3 (F-013): who someone wants to see and how — used only server-side
// (Explore, scoring), so it lives in the owner-only private/matching.
export const MATCHING_FIELDS = [
  'attractedTo', 'matchableAs', 'ageMin', 'ageMax', 'radiusMiles', 'drinkingHabit', 'showOrientation',
  'dealbreakers', 'seekingBodyTypes', 'seekingTraits', 'seekingHeightMinCm', 'seekingHeightMaxCm',
  // F-018 / §4.A1: never shown to anyone — matching only.
  'religion', 'politicalView',
] as const

export async function loadMatching(uid: string, root?: DocumentData): Promise<DocumentData> {
  const [m, r] = await Promise.all([matchingRef(uid).get(), root ? Promise.resolve(root) : userRef(uid).get().then((s) => s.data())])
  return withFallback(m.data(), r, MATCHING_FIELDS)
}

// Suspended (server-only flag in userInternal; older copies on the root doc
// count until migrated). Deleted accounts count as suspended.
export async function isSuspendedUid(uid: string, root?: DocumentData): Promise<boolean> {
  const r = root ?? (await userRef(uid).get()).data()
  if (r?.isDeleted === true) return true
  // The root copy too, until the Stage 3 migration has moved it (userInternal may hold the default false).
  return (await loadInternal(uid, r)).isSuspended === true || r?.isSuspended === true
}

// The owner's private profile metadata, root-doc copies as fallback.
export async function loadPrivateProfile(uid: string, root?: DocumentData): Promise<DocumentData> {
  const [p, r] = await Promise.all([profileRef(uid).get(), root ? Promise.resolve(root) : userRef(uid).get().then((s) => s.data())])
  return withFallback(p.data(), r, PRIVATE_PROFILE_FIELDS)
}

// A root doc with the private profile metadata merged back in — for scoring,
// which compares intents, server-side only.
export async function withPrivateProfile(uid: string, root: DocumentData): Promise<DocumentData> {
  const [meta, matching] = await Promise.all([loadPrivateProfile(uid, root), loadMatching(uid, root)])
  return { ...root, ...meta, ...matching }
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
  const fields = [...PLAN_FIELDS, 'playEntitled', 'playAccess', 'playAccessUntil', 'entitlement'] // Stage C: the tier
  const billing = typeof after.stripeCustomerId === 'string' && after.stripeCustomerId !== ''
  const billingBefore = typeof before.stripeCustomerId === 'string' && before.stripeCustomerId !== ''
  if (!fields.some(changed) && billing === billingBefore && event.data?.before.exists) return
  // Stage C: mirror the record as it is NOW, not as this event saw it — a
  // late-running trigger for an older write would otherwise put back (or
  // delete) a stale value over a newer one.
  const now = (await internalRef(uid).get()).data()
  if (!now) return
  const mirror: DocumentData = { hasBillingAccount: typeof now.stripeCustomerId === 'string' && now.stripeCustomerId !== '' }
  for (const f of fields) mirror[f] = now[f] === undefined ? FieldValue.delete() : now[f]
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
  [...INTERNAL_FIELDS, ...ACCOUNT_FIELDS, ...SETTINGS_FIELDS, ...IDENTITY_FIELDS, ...LOCATION_FIELDS, ...DROPPED_FIELDS, ...PLAY_ROOT_FIELDS, ...PRIVATE_PROFILE_FIELDS, ...MATCHING_FIELDS].map((f) => [f, FieldValue.delete()]),
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

// F-067: the moderation state a deletion carries — a suspension in force
// (not the one a pending deletion sets) and the report count — and whether
// the account's trust links (device sightings, trust profile) are kept
// through the deletion, so a sign-up again can still be linked to it. Device
// sightings still go after 90 days (purgeDeviceSightings).
export async function moderationCarry(uid: string): Promise<{ reportCount: number; suspension: DocumentData | null; keepTrustLinks: boolean }> {
  const n = (await internalRef(uid).get()).data() ?? {}
  const until = typeof n.suspendedUntil?.toMillis === 'function' ? (n.suspendedUntil.toMillis() as number) : null
  const live = n.isSuspended === true && n.suspendedForDeletion !== true && (until === null || until > Date.now())
  const reportCount = typeof n.reportCount === 'number' ? n.reportCount : 0
  return {
    reportCount,
    suspension: live
      ? {
          suspendedAt: n.suspendedAt ?? null,
          suspendedUntil: n.suspendedUntil ?? null,
          suspendedPendingReview: n.suspendedPendingReview === true,
          suspendSource: n.suspendSource ?? null,
          suspendReason: n.suspendReason ?? null,
          suspendedBy: n.suspendedBy ?? null,
        }
      : null,
    keepTrustLinks: live || reportCount > 0,
  }
}

// The deletedAccounts/{phone} recovery record — the one shape every delete
// path writes (self-delete, admin delete, the end of the 30-day grace), so
// restoreAccount can always re-inflate identity and the moderation state
// always comes along (F-067: the grace path wrote neither).
export async function recoveryRecord(uid: string, root: DocumentData, phoneNumber: string): Promise<DocumentData> {
  const [priv, matching, profile, carry, asA, asB] = await Promise.all([
    deletionView(uid, root),
    loadMatching(uid, root),
    loadPrivateProfile(uid, root),
    moderationCarry(uid),
    db().collection('pairs').where('userA', '==', uid).get(),
    db().collection('pairs').where('userB', '==', uid).get(),
  ])
  return {
    phoneNumber,
    previousUid: uid,
    deletedAt: Timestamp.now(),
    birthday: priv.birthday,
    genderIdentity: root.genderIdentity ?? null,
    matchableAs: matching.matchableAs ?? [],
    identityLockedAt: root.identityLockedAt ?? null,
    pronouns: root.pronouns ?? null,
    genderSelfDescribe: root.genderSelfDescribe ?? null,
    displayName: root.displayName ?? '',
    photoURLs: root.photoURLs ?? [],
    bio: root.bio ?? '',
    mode: profile.mode ?? 'spark',
    isFounder: root.isFounder ?? false,
    subscriptionTier: priv.subscriptionTier,
    reportCount: carry.reportCount,
    suspension: carry.suspension,
    banned: false,
    previousPairIds: [...asA.docs, ...asB.docs].map((d) => d.id),
  }
}

// Everything Play of a deleted account (Stage 2): the Play profile and PIN,
// Play photos, Play pair scores, Play likes they sent (in the other person's
// queue) and received (in their own), and their Play name and photo on the
// other person's Play match records. The other person's own data — the
// conversation, their likes — stays. Called by every delete path
// (clearPrivateData).
// F-062: and its Play identity — the public Play profile, Play-ID-keyed
// likes, Play matches (playMatches, named by Play ID), Play reveals, the
// photos under playPhotos/{playId}/ and finally the Play ID mapping itself.
export async function removePlayData(uid: string): Promise<void> {
  const firestore = db()
  const { playIdOf, removePlayId } = await import('./playIds')
  const { endPlayPair, loadMatch, playMatchIdsOf } = await import('./playMatch')
  const playId = await playIdOf(uid)
  const [pairsA, pairsB, playPairs, ownQueue, matches, playMatchIds, reveals] = await Promise.all([
    firestore.collection('pairs').where('userA', '==', uid).get(),
    firestore.collection('pairs').where('userB', '==', uid).get(),
    // F-065: Play scores and likes, keyed by Play IDs.
    firestore.collection('playPairData').where('users', 'array-contains', uid).get(),
    firestore.collection(`users/${uid}/likeQueue`).where('mode', '==', 'play').get(),
    firestore.collection('matches').where('users', 'array-contains', uid).where('mode', '==', 'play').get(),
    playMatchIdsOf(uid),
    firestore.collectionGroup('by').where('viewer', '==', uid).get(),
  ])
  const refs: DocumentReference[] = [
    ...(playId ? [firestore.doc(`playProfiles/${playId}`)] : []),
    ...reveals.docs.filter((d) => d.ref.parent.parent?.parent.id === 'playReveals').map((d) => d.ref),
    firestore.doc(`users/${uid}/playProfile/data`),
    firestore.doc(`users/${uid}/settings/playPin`),
    // Holds the Play visibility and pause time (with Spark's).
    firestore.doc(`users/${uid}/settings/pause`),
    ...ownQueue.docs.map((d) => d.ref),
  ]
  for (const p of playPairs.docs) {
    refs.push(p.ref)
    const users: unknown = p.get('users')
    const other = Array.isArray(users) ? users.find((u) => u !== uid) : undefined
    if (typeof other === 'string' && playId) refs.push(firestore.doc(`users/${other}/likeQueue/${playId}`))
  }
  for (const p of [...pairsA.docs, ...pairsB.docs]) {
    refs.push(firestore.doc(`pairs/${p.id}/modes/play`), firestore.doc(`pairs/${p.id}/likes/play`))
    const other = p.get('userA') === uid ? p.get('userB') : p.get('userA')
    if (typeof other === 'string') {
      const sent = firestore.doc(`users/${other}/likeQueue/${uid}`)
      if ((await sent.get()).get('mode') === 'play') refs.push(sent)
      if (playId) refs.push(firestore.doc(`users/${other}/likeQueue/${playId}`))
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
  // Play chats end as Spark ones do (removeTraces): the other person keeps a
  // read-only conversation with "Deleted User".
  const now = Timestamp.now()
  for (const id of playMatchIds) {
    const ctx = await loadMatch(id)
    if (!ctx) continue
    const me = ctx.idOf(uid)
    await ctx.ref.update({
      ...(ctx.data.unmatchedAt ? {} : { unmatchedAt: now, unmatchedBy: me }),
      [`participantSnapshots.${me}.displayName`]: 'Deleted User',
      [`participantSnapshots.${me}.photoURL`]: null,
    })
    await endPlayPair(ctx)
  }
  await firestore.recursiveDelete(firestore.collection(`playReveals/${uid}/by`)).catch(() => {})
  for (const prefix of [`photos/${uid}/play/`, ...(playId ? [`playPhotos/${playId}/`] : [])]) {
    await getStorage()
      .bucket()
      .deleteFiles({ prefix })
      .catch((err) => logger.warn('removePlayData: Storage delete failed', { message: String(err) }))
  }
  await removePlayId(uid)
}

// Removes the user's private docs, server-only record, location and (Stage 2)
// all their Play data — and (Stage B, F-057) everything else that's theirs
// or about them that a deleted account shouldn't leave behind. Every deletion
// path runs this (deleteAccount, the grace-period job, the admin delete, the
// nightly purge). Kept: the public doc's remains (anonymised, for a restore),
// their published photo files (a restore reuses them; the nightly purge
// removes them) and legalAcceptance (the record of what they agreed to).
// keepTrustLinks (F-067, moderationCarry): a suspended or reported account's
// device sightings and trust profile stay.
export async function clearPrivateData(uid: string, { keepTrustLinks = false }: { keepTrustLinks?: boolean } = {}): Promise<void> {
  await removePlayData(uid)
  await removeTraces(uid)
  await Promise.all([
    accountRef(uid).delete(),
    settingsRef(uid).delete(),
    identityRef(uid).delete(),
    profileRef(uid).delete(),
    matchingRef(uid).delete(),
    db().doc(`exploreIndex/${uid}`).delete(),
    db().doc(`exploreState/${uid}`).delete(),
    internalRef(uid).delete(),
    locationRef(uid).delete(),
    db().doc(`rateLimits/${uid}`).delete(),
    db().doc(`playPins/${uid}`).delete(),
    db().doc(`keyBackups/${uid}`).delete(),
    db().doc(`behaviorSignals/${uid}`).delete(),
    // T&S Phase 1: device sightings and the account's trust profile.
    ...(keepTrustLinks ? [] : [removeDeviceData(uid), db().doc(`trustProfiles/${uid}`).delete()]),
    // T&S Phase 2: AI / web-match results for its photos.
    db().doc(`photoSignals/${uid}`).delete(),
    // T&S Phase 5: its photo hashes and duplicate pairs (a scam ban copies
    // them to the blocklist first).
    removePhotoHashes(uid),
    // F-071: blocklist holds' context (kept server-only, photoHolds.ts).
    import('./photoHolds').then((m) => m.removePhotoHolds(uid)),
  ])
}

// Stage B (F-057): what's left of someone in other people's data and in
// their own subcollections.
async function removeTraces(uid: string): Promise<void> {
  const firestore = db()
  const [pairsA, pairsB, matches] = await Promise.all([
    firestore.collection('pairs').where('userA', '==', uid).get(),
    firestore.collection('pairs').where('userB', '==', uid).get(),
    firestore.collection('matches').where('users', 'array-contains', uid).get(),
  ])
  const refs: DocumentReference[] = []
  for (const p of [...pairsA.docs, ...pairsB.docs]) {
    const other = p.get('userA') === uid ? p.get('userB') : p.get('userA')
    // Their like (either mode) in the other person's queue, and the likes.
    if (typeof other === 'string') refs.push(firestore.doc(`users/${other}/likeQueue/${uid}`))
    refs.push(firestore.doc(`pairs/${p.id}/likes/spark`), firestore.doc(`pairs/${p.id}/likes/play`))
  }
  for (let i = 0; i < refs.length; i += 400) {
    const batch = firestore.batch()
    for (const r of refs.slice(i, i + 400)) batch.delete(r)
    await batch.commit()
  }
  // Their chats end: the other person keeps a read-only conversation with
  // "Deleted User" (no new messages — the rules refuse them once unmatched).
  const now = Timestamp.now()
  for (const m of matches.docs) {
    if (m.get('unmatchedAt')) continue
    await m.ref.update({
      unmatchedAt: now,
      unmatchedBy: uid,
      [`participantSnapshots.${uid}.displayName`]: 'Deleted User',
      [`participantSnapshots.${uid}.photoURL`]: null,
    })
  }
  // Their own records, besides the private docs cleared by the caller.
  for (const sub of ['likeQueue', 'profileReviews', 'zyloveScore', 'freeTierState', 'seekingPreferences', 'settings', 'profileViews', 'matches', 'matchIndex']) {
    await firestore.recursiveDelete(firestore.collection(`users/${uid}/${sub}`)).catch((err) =>
      logger.warn('clearPrivateData: subcollection delete failed', { sub, message: String(err) }),
    )
  }
  await firestore.recursiveDelete(firestore.doc(`founderMessages/${uid}`)).catch(() => {})
  // Founder status ends with the account (as the deletion warning says); the
  // spot goes back to the city.
  const { revokeFounderStatus } = await import('./founderActivity')
  await revokeFounderStatus(uid).catch((err) => logger.warn('clearPrivateData: founder revoke failed', { message: String(err) }))
  await getStorage()
    .bucket()
    .deleteFiles({ prefix: `reviews/${uid}/` })
    .catch((err) => logger.warn('clearPrivateData: review PDFs delete failed', { message: String(err) }))
}

// Stage B (F-058): user-facing callables refuse suspended accounts (a
// pending deletion counts — cancelling it lifts that). Reporting, blocking,
// unmatching and deleting stay open to them.
export async function requireActive(uid: string): Promise<void> {
  if (await isSuspendedUid(uid)) {
    const { HttpsError } = await import('firebase-functions/v2/https')
    throw new HttpsError('permission-denied', 'Account suspended')
  }
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
