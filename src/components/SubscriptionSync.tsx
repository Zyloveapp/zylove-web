import { useEffect } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { useSubscriptionStore } from '../store/subscriptionStore'
import { getDaysLeftInTrial, getUserTier, isAlwaysElite, subscribeTierFields } from '../services/subscription'

// Keeps useSubscriptionStore in step with the signed-in user's doc. If the
// doc can't be read, access fails open rather than locking anyone out.
export default function SubscriptionSync() {
  const uid = useAuthStore((s) => s.user?.uid) ?? null
  const set = useSubscriptionStore((s) => s.set)

  useEffect(() => {
    set({ uid, tier: null, daysLeft: null, alwaysElite: false })
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
          return set({ uid, tier: 'trial', daysLeft: null, alwaysElite: false })
        }
        set({ uid, tier: getUserTier(fields), daysLeft: getDaysLeftInTrial(fields), alwaysElite: isAlwaysElite(fields) })
      },
      () => set({ uid, tier: 'elite', daysLeft: null, alwaysElite: false }),
    )
  }, [uid, set])

  return null
}
