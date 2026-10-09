import { useEffect } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { useSubscriptionStore } from '../store/subscriptionStore'
import {
  entitlementOf,
  getDaysLeftInTrial,
  getSubscriptionStatus,
  getUserTier,
  hasTrialEnded,
  isAlwaysElite,
  marketOf,
  subscribeTierFields,
  trialStarted,
} from '../services/subscription'

const EMPTY = { daysLeft: null, alwaysElite: false, subscriptionStatus: null, trialEnded: false, marketName: null } as const

// Keeps useSubscriptionStore in step with the signed-in user's plan (the
// server's entitlement). If it can't be read, the app shows Free.
//
// No trial yet (pre-launch, or Free while their open city's trial starts):
// asks the server (initUserDefaults) to start one in case their market has
// opened — once per session, and again if their saved location moves to
// another market. The server decides; in a market that hasn't opened it does
// nothing. (It starts the trial by itself too — H1; this only saves a wait.)
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
        if (tier === 'prelaunch' || (entitlementOf(fields)?.source === 'waiting' && !trialStarted(fields))) {
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
      // Stage C: unreadable → Free (fails closed; the server enforces anyway).
      () => set({ uid, tier: 'free', ...EMPTY }),
    )
  }, [uid, set])

  return null
}
