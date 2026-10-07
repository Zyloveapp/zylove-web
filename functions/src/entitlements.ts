import { Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { ZYLOVE_CITIES } from './cities'
import { eliteByMatching } from './identity'

// Stage C: what someone's plan gives them, decided once, server-side.
// userInternal/{uid}.entitlement = { tier, source, until, cityId } (mirrored
// read-only to private/account). Rules, callables and the app all read it;
// the app never decides access itself.
//
//   tier     'free' | 'spark_plus' | 'elite' (Elite includes everything
//            Spark+ has)
//   source   why: identity (matched as women / nonbinary people — decision
//            2), founder, paid, trial, prelaunch (near a launch city still
//            in its founding period), waiting (no launch city yet: no
//            location, or linked to a major city that hasn't launched —
//            decision 1), free (trial over, or cancelled: never a second
//            trial or pre-launch)
//   until    when a trial grants it: its end (rules compare it with
//            request.time); else null
//   cityId   the launch city (or linked major city) it was decided for

export type Tier = 'free' | 'spark_plus' | 'elite'
export type Source = 'identity' | 'founder' | 'paid' | 'trial' | 'prelaunch' | 'waiting' | 'free'
export interface Entitlement {
  tier: Tier
  source: Source
  until: Timestamp | null
  cityId: string | null
}

const RANK: Record<Tier, number> = { free: 0, spark_plus: 1, elite: 2 }
export const atLeast = (have: Tier, need: Tier) => RANK[have] >= RANK[need]

function toMillis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis()
  if (typeof v === 'number') return v
  return null
}

export function cityIsOpen(config: DocumentData | undefined): boolean {
  return config?.discoveryOpenedAt != null || config?.botsActive === false
}

// The launch city someone belongs to: their locked market, or the major
// city they're linked to once it has become a launch city.
export function launchCityOf(loc: DocumentData | undefined): string | null {
  const ids = [loc?.marketCityId, loc?.linkedCityId].filter((x): x is string => typeof x === 'string')
  return ids.find((id) => ZYLOVE_CITIES.some((c) => c.id === id)) ?? null
}

export function computeEntitlement(
  input: { root?: DocumentData; plan?: DocumentData; matching?: DocumentData; loc?: DocumentData; cityOpen?: boolean },
  now = Date.now(),
): Entitlement {
  const { root, plan = {}, matching = {}, loc } = input
  const cityId = launchCityOf(loc) ?? (typeof loc?.linkedCityId === 'string' ? loc.linkedCityId : null)
  const e = (tier: Tier, source: Source, until: number | null = null): Entitlement => ({
    tier,
    source,
    until: until === null ? null : Timestamp.fromMillis(until),
    cityId,
  })
  if (!root || root.isDeleted === true) return e('free', 'free')
  if (eliteByMatching(root.genderIdentity, matching.matchableAs)) return e('elite', 'identity')
  if (root.isFounder === true) return e('elite', 'founder')
  if (plan.subscriptionTier === 'elite') return e('elite', 'paid')
  if (plan.subscriptionTier === 'spark_plus') return e('spark_plus', 'paid')
  if (plan.trialStartedAt != null) {
    const ends = toMillis(plan.trialEndsAt)
    return plan.trialExpired !== true && ends !== null && ends > now ? e('elite', 'trial', ends) : e('free', 'free')
  }
  // Never had a trial: a cancelled subscriber gets neither a trial nor pre-launch.
  if (plan.hadPaidPlan === true) return e('free', 'free')
  if (!launchCityOf(loc)) return e('free', 'waiting')
  // Near a launch city: Elite while it's founding, and once it's open until
  // their trial starts (initUserDefaults / onMarketOpened start it).
  return e('elite', 'prelaunch')
}

// Everything needed, read now.
export async function loadEntitlement(uid: string, root?: DocumentData, plan?: DocumentData): Promise<Entitlement> {
  const db = getFirestore()
  const [r, p, m, l] = await Promise.all([
    root ? Promise.resolve(root) : db.doc(`users/${uid}`).get().then((s) => s.data()),
    plan ? Promise.resolve(plan) : db.doc(`userInternal/${uid}`).get().then((s) => s.data()),
    db.doc(`users/${uid}/private/matching`).get().then((s) => s.data()),
    db.doc(`userLocations/${uid}`).get().then((s) => s.data()),
  ])
  return computeEntitlement({ root: r, plan: p, matching: m ?? { matchableAs: r?.matchableAs }, loc: l })
}

// The stored tier, as of now (a trial past its end counts as Free). Bots are Elite.
export async function tierNow(uid: string): Promise<Tier> {
  if (uid.startsWith('zbot-')) return 'elite'
  const e = (await getFirestore().doc(`userInternal/${uid}`).get()).get('entitlement') as DocumentData | undefined
  if (!e || typeof e.tier !== 'string') return 'free'
  const until = toMillis(e.until)
  if (until !== null && until <= Date.now()) return 'free'
  return e.tier === 'elite' || e.tier === 'spark_plus' ? e.tier : 'free'
}

export async function requireTier(uid: string, need: Tier, what = 'This'): Promise<Tier> {
  const tier = await tierNow(uid)
  if (!atLeast(tier, need)) {
    const { HttpsError } = await import('firebase-functions/v2/https')
    throw new HttpsError('permission-denied', `${what} needs ${need === 'elite' ? 'Elite' : 'Spark+'}.`, { upgrade: need })
  }
  return tier
}
