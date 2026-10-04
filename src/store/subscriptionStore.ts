import { create } from 'zustand'
import type { SubscriptionStatus, Tier } from '../services/subscription'

// The signed-in user's tier, kept live by SubscriptionSync. tier is null
// until the user doc has loaded (gates wait rather than flash a paywall).
interface SubscriptionState {
  uid: string | null
  tier: Tier | null
  daysLeft: number | null
  alwaysElite: boolean
  subscriptionStatus: SubscriptionStatus | null
  // Free because the trial is over (TrialExpiry blocks the app).
  trialEnded: boolean
  set: (s: Omit<SubscriptionState, 'set'>) => void
}

export const useSubscriptionStore = create<SubscriptionState>((set) => ({
  uid: null,
  tier: null,
  daysLeft: null,
  alwaysElite: false,
  subscriptionStatus: null,
  trialEnded: false,
  set: (s) => set(s),
}))
