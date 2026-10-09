import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { cityIsOpen, launchCityOf } from './entitlements'
import { NEW_ACCOUNT_MS } from './shared/scamRules'
import { newTrial, noteTrialHistory, planView, priorTrial, trialExempt } from './trial'
import { internalRef, loadMatching, userRef } from './userData'

// H1 (fresh-eyes review): what the server relies on about an account's age
// and plan, filled in server-side. These used to be set only by the
// client-called initUserDefaults, so an account whose app never called it
// stayed Elite "pre-launch" with no end once its city opened, skipped the
// once-per-phone trial (trialHistory) and was never on probation.
//
//   accountCreatedAt   userInternal (ms, from Firebase Auth — the client's
//                      createdAt can be rewritten); probation, trust and the
//                      scam-report bar read it
//   memberSince        users/{uid} ("2026-10", the month only)
//   newUntil           users/{uid}: while under 48 hours old, when that ends
//                      (to the hour), for the recipient's link safety note
//   the trial          userInternal: once per phone number (trialHistory) —
//                      a past paid plan (hadPaidPlan) or the trial they had
//                      comes back instead of a new one — and a new one only
//                      in a launch city that's open; never while suspended
//                      (F-097), never for the exempt (trial.ts)
//
// Run by refreshPlayAccess (every entitlement trigger: the profile created,
// the location saved, the city opening, the plan changing) whenever one is
// missing, and by initUserDefaults. Idempotent: written in a transaction,
// only what's still missing.

const isBot = (uid: string) => /^(zbot|seed)-/.test(uid)

// "2026-10": the month an account was created, Central time.
export function memberSinceOf(ms: number): string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).format(new Date(ms))
  return f.slice(0, 7)
}

export type TrialDecision =
  | { kind: 'none' }
  // A paid plan on record by phone: Free, never a trial.
  | { kind: 'paid' }
  // The trial this number already had (over, or still running).
  | { kind: 'prior'; trialStartedAt: Timestamp; trialEndsAt: Timestamp }
  | { kind: 'new' }

// Pure: what initUserDefaults decided, from the docs at hand. `prior` is
// trialHistory/{phoneHash} (null: none, or no phone).
export function decideTrial(input: {
  root: DocumentData
  internal: DocumentData
  matching: DocumentData
  cityOpen: boolean
  prior: DocumentData | null
}): TrialDecision {
  const { root, internal, matching, prior } = input
  if (internal.trialStartedAt !== undefined || internal.hadPaidPlan === true) return { kind: 'none' }
  // F-097: nothing started while suspended (a pending deletion counts).
  if (internal.isSuspended === true || root.isSuspended === true) return { kind: 'none' }
  if (trialExempt({ ...planView(root, internal), genderIdentity: matching.genderIdentity, matchableAs: matching.matchableAs })) return { kind: 'none' }
  if (prior?.hadPaidPlan === true) return { kind: 'paid' }
  if (prior?.trialStartedAt instanceof Timestamp && prior.trialEndsAt instanceof Timestamp) {
    return { kind: 'prior', trialStartedAt: prior.trialStartedAt, trialEndsAt: prior.trialEndsAt }
  }
  return input.cityOpen ? { kind: 'new' } : { kind: 'none' }
}

// Whether ensureAccountDefaults has anything to do for these docs (a cheap
// check for the triggers: no Auth or trialHistory lookups).
export function needsAccountDefaults(root: DocumentData | undefined, internal: DocumentData | undefined): boolean {
  if (!root || root.isDeleted === true) return false
  const n = internal ?? {}
  return typeof n.accountCreatedAt !== 'number' || typeof root.memberSince !== 'string' || (n.trialStartedAt === undefined && n.hadPaidPlan !== true)
}

// Fills in what's missing (see above). `known` (scripts): the phone number
// and Auth creation time, when the caller already has them — the admin Auth
// SDK isn't usable under user credentials.
export async function ensureAccountDefaults(
  uid: string,
  known: { phone?: string | null; createdAt?: number | null } = {},
): Promise<{ trial: TrialDecision['kind']; filled: string[] }> {
  const none = { trial: 'none' as const, filled: [] }
  if (isBot(uid)) return none
  const db = getFirestore()
  const [rootSnap, internalSnap, locSnap] = await Promise.all([userRef(uid).get(), internalRef(uid).get(), db.doc(`userLocations/${uid}`).get()])
  const root = rootSnap.data()
  // Never a stub: the profile must exist (onboarding saves it first).
  if (!root || root.isDeleted === true) return none
  const internal = internalSnap.data() ?? {}
  if (!needsAccountDefaults(root, internal)) return none

  const authUser = known.phone !== undefined && known.createdAt !== undefined ? null : await getAuth().getUser(uid).catch(() => null)
  const phone = known.phone !== undefined ? known.phone : (authUser?.phoneNumber ?? null)
  const created = known.createdAt !== undefined ? known.createdAt : Date.parse(authUser?.metadata.creationTime ?? '')
  const cityId = launchCityOf(locSnap.data())
  const cityOpen = cityId ? cityIsOpen((await db.doc(`config/city_${cityId}`).get()).data()) : false
  const maybeTrial = internal.trialStartedAt === undefined && internal.hadPaidPlan !== true
  const prior = maybeTrial ? await priorTrial(phone) : null
  const matching = maybeTrial ? await loadMatching(uid, root) : {}

  const result = await db.runTransaction(async (tx) => {
    const [r, n] = await Promise.all([tx.get(userRef(uid)), tx.get(internalRef(uid))])
    const rootNow = r.data()
    if (!rootNow || rootNow.isDeleted === true) return none
    const cur = n.data() ?? {}
    const toInternal: DocumentData = {}
    const toRoot: DocumentData = {}
    const createdOk = typeof created === 'number' && Number.isFinite(created)
    if (typeof cur.accountCreatedAt !== 'number' && createdOk) toInternal.accountCreatedAt = created
    if (typeof rootNow.memberSince !== 'string' && createdOk) toRoot.memberSince = memberSinceOf(created as number)
    const createdAt = typeof cur.accountCreatedAt === 'number' ? cur.accountCreatedAt : (toInternal.accountCreatedAt as number | undefined)
    if (typeof rootNow.newUntil !== 'number' && typeof createdAt === 'number' && Date.now() < createdAt + NEW_ACCOUNT_MS) {
      toRoot.newUntil = Math.ceil((createdAt + NEW_ACCOUNT_MS) / 3_600_000) * 3_600_000
    }
    // Decided again on the docs as they are now: a trial another run (or
    // onMarketOpened, or a test) wrote meanwhile stays.
    const trial = decideTrial({ root: rootNow, internal: cur, matching, cityOpen, prior })
    if (trial.kind === 'paid') toInternal.hadPaidPlan = true
    if (trial.kind === 'prior') {
      Object.assign(toInternal, { trialStartedAt: trial.trialStartedAt, trialEndsAt: trial.trialEndsAt, trialExpired: trial.trialEndsAt.toMillis() <= Date.now() })
    }
    if (trial.kind === 'new') Object.assign(toInternal, newTrial())
    if (Object.keys(toInternal).length) tx.set(internalRef(uid), toInternal, { merge: true })
    if (Object.keys(toRoot).length) tx.update(userRef(uid), toRoot)
    return { trial: trial.kind, filled: [...Object.keys(toInternal), ...Object.keys(toRoot)], started: toInternal.trialStartedAt as Timestamp | undefined, ends: toInternal.trialEndsAt as Timestamp | undefined }
  })
  // On record by phone, so deleting the account and signing up again
  // doesn't bring a fresh one.
  if (result.trial === 'new' && 'started' in result) await noteTrialHistory(phone, { trialStartedAt: result.started, trialEndsAt: result.ends })
  if (result.filled.length) logger.info('ensureAccountDefaults: filled missing fields', { fields: result.filled, trial: result.trial })
  return { trial: result.trial, filled: result.filled }
}
