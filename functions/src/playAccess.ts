import { HttpsError } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { hasEliteIdentity } from './trial'
import { internalRef, userRef } from './userData'

// Play access (Stage 2, F-004). Play data is sealed: reading another
// person's Play profile, Play photos, Play scores, Play matches or Play likes
// takes Play access, enforced by the rules (which read the flags below) and
// by the callables here.
//
//   entitled     the plan includes Play — the app's getUserTier rule
//                (subscription.ts canAccess 'play_mode'): the always-Elite
//                identities, founders, an Elite subscription, pre-launch (no
//                trial started), or a trial that hasn't ended. Spark+ and
//                Free don't. Enough to act in Play yourself (onboarding,
//                AI help, your own profile).
//   playAccess   entitled + a finished Play profile + not suspended or
//                deleted. Needed to see anyone else's Play data — and for
//                anyone to see yours.
//
// Stored server-side in userInternal/{uid}: playEntitled, playAccess and
// playAccessUntil (the trial's end when that's what grants it, else null),
// recomputed whenever the plan, the profile or the Play profile changes.
// The rules compare playAccessUntil with request.time, so a trial ending
// takes effect on the second, before the nightly checkTrialStatus run.
// Bots (zbot-) always have Play access: they're the Play preview.

export const BOT_PREFIX = 'zbot-'
export const isBotUid = (uid: string): boolean => uid.startsWith(BOT_PREFIX)

function toMillis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis()
  if (typeof v === 'number') return v
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return Date.parse(v)
  return null
}

export interface PlayFlags {
  playEntitled: boolean
  playAccess: boolean
  // When a trial is what grants it: when it stops. Otherwise null.
  playAccessUntil: Timestamp | null
}

// Entitlement from the root doc (identity, founder) and the plan (userInternal).
export function entitlement(root: DocumentData | undefined, plan: DocumentData | undefined, now = Date.now()): { entitled: boolean; until: number | null } {
  if (!root) return { entitled: false, until: null }
  if (hasEliteIdentity(root) || root.isFounder === true) return { entitled: true, until: null }
  const p = plan ?? {}
  if (p.subscriptionTier === 'elite') return { entitled: true, until: null }
  if (p.subscriptionTier === 'spark_plus') return { entitled: false, until: null }
  if (p.trialStartedAt == null) return { entitled: true, until: null } // pre-launch
  const ends = toMillis(p.trialEndsAt)
  if (p.trialExpired !== true && ends !== null && ends > now) return { entitled: true, until: ends }
  return { entitled: false, until: null }
}

export function computeFlags(root: DocumentData | undefined, plan: DocumentData | undefined, play: DocumentData | undefined): PlayFlags {
  const { entitled, until } = entitlement(root, plan)
  const live = !!root && root.isSuspended !== true && root.isDeleted !== true
  const finished = play?.playOnboardingComplete === true
  const access = entitled && live && finished
  return { playEntitled: entitled, playAccess: access, playAccessUntil: access && until !== null ? Timestamp.fromMillis(until) : null }
}

// Recomputes and stores the flags (only when they changed).
export async function refreshPlayAccess(uid: string): Promise<PlayFlags> {
  const db = getFirestore()
  const [root, internal, play] = await Promise.all([
    userRef(uid).get(),
    internalRef(uid).get(),
    db.doc(`users/${uid}/playProfile/data`).get(),
  ])
  const flags = computeFlags(root.data(), internal.data(), play.data())
  // A deleted account's server record is gone for good (clearPrivateData):
  // never write it back.
  if (!root.exists || root.data()?.isDeleted === true) return flags
  const cur = internal.data() ?? {}
  const same =
    cur.playEntitled === flags.playEntitled &&
    cur.playAccess === flags.playAccess &&
    (toMillis(cur.playAccessUntil) ?? null) === (flags.playAccessUntil?.toMillis() ?? null)
  if (!same) await internalRef(uid).set(flags, { merge: true })
  return flags
}

// The stored flags, read now: entitled / access as of this moment.
export async function playStatus(uid: string): Promise<{ entitled: boolean; access: boolean }> {
  if (isBotUid(uid)) return { entitled: true, access: true }
  const d = (await internalRef(uid).get()).data() ?? {}
  const until = toMillis(d.playAccessUntil)
  const current = until === null || until > Date.now()
  return { entitled: d.playEntitled === true && current, access: d.playAccess === true && current }
}

export async function requirePlayAccess(uid: string): Promise<void> {
  if (!(await playStatus(uid)).access) {
    throw new HttpsError('permission-denied', 'Play needs an active Play profile and a plan that includes Play.')
  }
}

export async function requirePlayEntitled(uid: string): Promise<void> {
  if (!(await playStatus(uid)).entitled) throw new HttpsError('permission-denied', 'Your plan doesn’t include Play.')
}

// Play visibility ('active' | 'paused' | 'hidden') lives on the Play
// profile, server-written; nothing to do for someone without one.
export async function setPlayVisibility(uid: string, visibility: 'active' | 'paused' | 'hidden'): Promise<void> {
  const ref = getFirestore().doc(`users/${uid}/playProfile/data`)
  if ((await ref.get()).exists) await ref.update({ playVisibility: visibility })
}

// ─── Triggers ────────────────────────────────────────────────────────────────

const PLAN_KEYS = ['subscriptionTier', 'trialStartedAt', 'trialEndsAt', 'trialExpired']
const ROOT_KEYS = ['genderIdentity', 'isFounder', 'isSuspended', 'isDeleted']
const changed = (before: DocumentData | undefined, after: DocumentData | undefined, keys: string[]) =>
  keys.some((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null))

// Plan changes (trial start/end, subscriptions).
export const playAccessOnPlan = onDocumentWritten({ document: 'userInternal/{uid}', memory: '256MiB' }, async (event) => {
  // Deleted (account deletion clears it): nothing to recompute.
  if (!event.data?.after.exists) return
  if (!changed(event.data?.before.data(), event.data?.after.data(), PLAN_KEYS)) return
  const flags = await refreshPlayAccess(event.params.uid)
  logger.info('playAccessOnPlan', { access: flags.playAccess })
})

// Identity, founder status, suspension, deletion.
export const playAccessOnProfile = onDocumentWritten({ document: 'users/{uid}', memory: '256MiB' }, async (event) => {
  if (isBotUid(event.params.uid)) return
  if (event.data?.before.exists && !changed(event.data.before.data(), event.data?.after.data(), ROOT_KEYS)) return
  await refreshPlayAccess(event.params.uid)
})

// Finishing (or deleting) the Play profile.
export const playAccessOnPlayProfile = onDocumentWritten({ document: 'users/{uid}/playProfile/data', memory: '256MiB' }, async (event) => {
  if (isBotUid(event.params.uid)) return
  const b = event.data?.before.data(), a = event.data?.after.data()
  if (event.data?.before.exists && event.data?.after.exists && b?.playOnboardingComplete === a?.playOnboardingComplete) return
  await refreshPlayAccess(event.params.uid)
})
