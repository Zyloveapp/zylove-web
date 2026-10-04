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
  subscribeTierFields,
} from '../services/subscription'

const EMPTY = { daysLeft: null, alwaysElite: false, subscriptionStatus: null, trialEnded: false } as const

// Keeps useSubscriptionStore in step with the signed-in user's doc. If the
// doc can't be read, access fails open rather than locking anyone out.
export default function SubscriptionSync() {
  const uid = useAuthStore((s) => s.user?.uid) ?? null
  const set = useSubscriptionStore((s) => s.set)

  useEffect(() => {
    set({ uid, tier: null, ...EMPTY })
    if (!uid) return
    let trialRequested = false
    return subscribeTierFields(
      uid,
      (fields) => {
        // No trial recorded yet (accounts from before trials, or onboarding's
        // call failed): start it now, and don't lock anything meanwhile.
        if (fields.trialEndsAt === undefined && getUserTier(fields) === 'free') {
          if (!trialRequested) {
            trialRequested = true
            httpsCallable(functions, 'initUserDefaults')({}).catch(() => {})
          }
          return set({ uid, tier: 'trial', ...EMPTY })
        }
        set({
          uid,
          tier: getUserTier(fields),
          daysLeft: getDaysLeftInTrial(fields),
          alwaysElite: isAlwaysElite(fields),
          subscriptionStatus: getSubscriptionStatus(fields),
          trialEnded: hasTrialEnded(fields),
        })
      },
      () => set({ uid, tier: 'elite', ...EMPTY }),
    )
  }, [uid, set])

  return null
}
