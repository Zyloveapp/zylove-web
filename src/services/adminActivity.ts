import { doc, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'

// Admin activity dashboard (functions/src/adminActivity.ts). Every call is
// checked server-side for users/{uid}.isAdmin.

export type Tier = 'founder' | 'elite' | 'spark_plus' | 'trial' | 'prelaunch' | 'free'
export type Mode = 'spark' | 'play' | 'both' | 'none'
export type Status = 'active' | 'hidden' | 'suspended' | 'deleted'

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

export interface ActivityQuery {
  page: number
  mode: 'all' | 'spark' | 'play' | 'both'
  tier: 'all' | Tier
  activity: 'all' | 'today' | 'week' | 'inactive7'
  city: string
  sort: 'newest' | 'last_active' | 'messages' | 'tier'
}

export interface Activity {
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

export async function getActivity(query: ActivityQuery): Promise<Activity> {
  const { data } = await httpsCallable<ActivityQuery, Activity>(functions, 'adminGetActivity', { timeout: 120_000 })(query)
  return data
}

export type UserAction = 'make_founder' | 'suspend' | 'unsuspend' | 'delete'
export type ActionResult = { ok: true; founder?: { eligible: true; cohortNumber: number; cityName?: string } | { eligible: false; reason: string } }

export async function runUserAction(uid: string, action: UserAction): Promise<ActionResult> {
  const { data } = await httpsCallable<{ uid: string; action: UserAction }, ActionResult>(functions, 'adminUserAction', {
    timeout: 120_000,
  })({ uid, action })
  return data
}

// ─── Activity tracking ───────────────────────────────────────────────────────
// users/{uid}.lastActive (epoch ms, as web onboarding writes it) on app
// load, at most once an hour per browser — what "Active today" counts.

const ACTIVE_THROTTLE_MS = 60 * 60 * 1000

export async function touchLastActive(uid: string): Promise<void> {
  const key = `zylove_last_active_${uid}`
  try {
    const last = Number(localStorage.getItem(key))
    if (last > 0 && Date.now() - last < ACTIVE_THROTTLE_MS) return
    await updateDoc(doc(db, 'users', uid), { lastActive: Date.now() })
    localStorage.setItem(key, String(Date.now()))
  } catch {
    // Not onboarded yet (no doc) or storage blocked: next load tries again.
  }
}
