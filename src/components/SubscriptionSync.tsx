import { useEffect } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { useSubscriptionStore } from '../store/subscriptionStore'
import {
  getDaysLeftInTrial,
  getSubscriptionStatus,
  getUserTier,
  hasTrialEnded,
  isAlwaysElite,
  marketOf,
  subscribeTierFields,
} from '../services/subscription'

const EMPTY = { daysLeft: null, alwaysElite: false, subscriptionStatus: null, trialEnded: false, marketName: null } as const

// Keeps useSubscriptionStore in step with the signed-in user's doc. If the
// doc can't be read, access fails open rather than locking anyone out.
//
// No trial yet (pre-launch): asks the server (initUserDefaults) to start one
// in case their market has opened — once per session, and again if their
// saved location moves to another market. The server decides; in a market
// that hasn't opened it does nothing.
export default function SubscriptionSync() {
  const uid = useAuthStore((s) => s.user?.uid) ?? null
  const set = useSubscriptionStore((s) => s.set)

  useEffect(() => {
    set({ uid, tier: null, ...EMPTY })
    if (!uid) return
    let askedFor: string | null = null
    return subscribeTierFields(
      uid,
      (fields) => {
        const tier = getUserTier(fields)
        const market = marketOf(fields)
        if (tier === 'prelaunch') {
          const key = market?.id ?? 'none'
          if (askedFor !== key) {
            askedFor = key
            httpsCallable(functions, 'initUserDefaults')({}).catch(() => {})
          }
        }
        set({
          uid,
          tier,
          daysLeft: getDaysLeftInTrial(fields),
          alwaysElite: isAlwaysElite(fields),
          subscriptionStatus: getSubscriptionStatus(fields),
          trialEnded: hasTrialEnded(fields),
          marketName: market?.name ?? null,
        })
      },
      () => set({ uid, tier: 'elite', ...EMPTY }),
    )
  }, [uid, set])

  return null
}
