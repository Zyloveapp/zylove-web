import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { getFirestore } from 'firebase-admin/firestore'
import { recordCapHit } from './trustSignals'
import { tierNow, type Tier } from './entitlements'
import { probationOf } from './probation'

// Stage C: every paid or limited feature's allowance, per tier, enforced
// here — the app only shows what's left (getUsage). Periods are calendar
// days / ISO weeks / months in Central time, or the account's lifetime
// ('life': Free's one-at-onboarding AI tools — uses made earlier, during a
// trial or pre-launch, count too). null: unlimited. 0: not in this tier.
//
// usage/{uid} (server-only): { [feature]: { [periodKey]: count, life: count } }

export type Period = 'day' | 'week' | 'month' | 'life'
export interface Allowance {
  max: number | null
  period: Period
}
type Table = Record<Tier, Allowance>

const unlimited: Allowance = { max: null, period: 'day' }
const none: Allowance = { max: 0, period: 'life' }
const sparkAi: Table = { free: { max: 1, period: 'life' }, spark_plus: { max: 2, period: 'month' }, elite: { max: 5, period: 'month' } }
const playAi: Table = { free: none, spark_plus: none, elite: { max: 5, period: 'month' } }

export const QUOTAS = {
  likes: { free: { max: 10, period: 'day' }, spark_plus: unlimited, elite: unlimited },
  // Conversation starters: the in-chat nudge and Break the ice share it
  // (Break the ice itself is Spark+).
  starters: { free: { max: 1, period: 'week' }, spark_plus: { max: 5, period: 'day' }, elite: { max: 5, period: 'day' } },
  profileQuestion: { free: { max: 3, period: 'day' }, spark_plus: { max: 3, period: 'day' }, elite: { max: 3, period: 'day' } },
  botReplies: { free: { max: 30, period: 'day' }, spark_plus: { max: 30, period: 'day' }, elite: { max: 30, period: 'day' } },
  sparkBio: sparkAi,
  sparkReview: sparkAi,
  sparkGoDeeper: sparkAi,
  playBio: playAi,
  playReview: playAi,
  playGoDeeper: playAi,
} satisfies Record<string, Table>
export type Feature = keyof typeof QUOTAS

const TZ = 'America/Chicago'
function parts(now: Date): { y: number; m: number; d: number } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const [y, m, d] = f.split('-').map(Number)
  return { y, m, d }
}
export function periodKey(period: Period, now = new Date()): string {
  if (period === 'life') return 'life'
  const { y, m, d } = parts(now)
  if (period === 'month') return `m:${y}-${String(m).padStart(2, '0')}`
  if (period === 'day') return `d:${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  // ISO week of the Central-time date.
  const date = new Date(Date.UTC(y, m - 1, d))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `w:${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

const db = () => getFirestore()
const usageRef = (uid: string) => db().doc(`usage/${uid}`)
const LIMIT_TEXT: Record<Period, string> = { day: 'today', week: 'this week', month: 'this month', life: 'on your plan' }

// Takes one use of `feature` for `uid` (or refuses), returning a refund for
// when the thing it paid for didn't happen.
// T&S Phase 2: a new account in a city with probation on gets fewer likes
// a day, whatever the plan (no upgrade prompt for that cap).
async function allowanceFor(uid: string, feature: Feature, t: Tier): Promise<{ rule: Allowance; probation: boolean }> {
  const rule: Allowance = QUOTAS[feature][t]
  if (feature !== 'likes') return { rule, probation: false }
  const p = await probationOf(uid)
  if (!p || (rule.max !== null && rule.max <= p.likesPerDay)) return { rule, probation: false }
  return { rule: { max: p.likesPerDay, period: 'day' }, probation: true }
}

export async function takeQuota(uid: string, feature: Feature, tier?: Tier): Promise<() => Promise<void>> {
  const t = tier ?? (await tierNow(uid))
  const { rule, probation } = await allowanceFor(uid, feature, t)
  if (rule.max === 0) throw new HttpsError('permission-denied', 'Not included in your plan.', { upgrade: t === 'free' ? 'spark_plus' : 'elite' })
  const key = periodKey(rule.period)
  await db().runTransaction(async (tx) => {
    const cur = ((await tx.get(usageRef(uid))).get(feature) ?? {}) as Record<string, number>
    const used = cur[key] ?? 0
    if (rule.max !== null && used >= rule.max) {
      // T&S Phase 1: hitting the like cap is a behaviour signal.
      if (feature === 'likes') void recordCapHit(uid)
      throw new HttpsError('resource-exhausted', `You've used all ${rule.max} ${LIMIT_TEXT[rule.period] === 'on your plan' ? 'included in your plan' : `for ${LIMIT_TEXT[rule.period]}`}.`, {
        upgrade: probation || t === 'elite' ? null : t === 'free' ? 'spark_plus' : 'elite',
      })
    }
    const next: Record<string, number> = { life: (cur.life ?? 0) + 1 }
    if (key !== 'life') next[key] = used + 1
    // The whole field is replaced: old periods drop off.
    tx.set(usageRef(uid), { [feature]: next }, { mergeFields: [feature] })
  })
  return async () => {
    await db()
      .runTransaction(async (tx) => {
        const cur = ((await tx.get(usageRef(uid))).get(feature) ?? {}) as Record<string, number>
        const next: Record<string, number> = { life: Math.max(0, (cur.life ?? 1) - 1) }
        if (key !== 'life') next[key] = Math.max(0, (cur[key] ?? 1) - 1)
        tx.set(usageRef(uid), { [feature]: next }, { mergeFields: [feature] })
      })
      .catch(() => {})
  }
}

// What's left of each allowance, for the app's "7 likes left today".
export const getUsage = onCall({ timeoutSeconds: 15, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  const [tier, snap] = await Promise.all([tierNow(uid), usageRef(uid).get()])
  const out: Record<string, { used: number; limit: number | null; period: Period }> = {}
  for (const f of Object.keys(QUOTAS) as Feature[]) {
    const { rule } = await allowanceFor(uid, f, tier)
    const cur = (snap.get(f) ?? {}) as Record<string, number>
    out[f] = { used: cur[periodKey(rule.period)] ?? 0, limit: rule.max, period: rule.period }
  }
  return { tier, usage: out }
})
