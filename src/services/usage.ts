import { useEffect, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

// What's left of the plan's allowances (Stage C; enforced server-side by
// functions/src/usage.ts — this only shows it: "7 likes left today").

export type UsageFeature =
  | 'likes'
  | 'starters'
  | 'profileQuestion'
  | 'sparkBio'
  | 'sparkReview'
  | 'sparkGoDeeper'
  | 'playBio'
  | 'playReview'
  | 'playGoDeeper'

export interface Allowance {
  used: number
  limit: number | null // null: unlimited
  period: 'day' | 'week' | 'month' | 'life'
}

export async function fetchUsage(): Promise<Record<string, Allowance>> {
  const { data } = await httpsCallable<Record<string, never>, { usage: Record<string, Allowance> }>(functions, 'getUsage')({})
  return data.usage
}

const PERIOD: Record<Allowance['period'], string> = { day: 'today', week: 'this week', month: 'this month', life: '' }

// "7 likes left today", or null when it's unlimited (or unknown).
export function leftText(a: Allowance | undefined, noun: [string, string]): string | null {
  if (!a || a.limit === null) return null
  const left = Math.max(0, a.limit - a.used)
  return `${left} ${left === 1 ? noun[0] : noun[1]} left${PERIOD[a.period] ? ` ${PERIOD[a.period]}` : ''}`
}

// One allowance, refreshed on demand (after using it).
export function useAllowance(feature: UsageFeature, uid: string): { allowance: Allowance | undefined; refresh: () => void } {
  const [state, setState] = useState<{ uid: string; n: number; a?: Allowance } | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!uid) return
    let cancelled = false
    fetchUsage().then(
      (u) => !cancelled && setState({ uid, n, a: u[feature] }),
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [uid, feature, n])
  return { allowance: state?.uid === uid ? state.a : undefined, refresh: () => setN((x) => x + 1) }
}
