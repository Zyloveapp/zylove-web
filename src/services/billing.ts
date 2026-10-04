import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

export type PaidTier = 'spark_plus' | 'elite'

export const PLAN_NAMES: Record<PaidTier, string> = { spark_plus: 'Spark+', elite: 'Elite' }

// Both send the browser to a Stripe-hosted page; they only return on failure.

export async function startCheckout(tier: PaidTier): Promise<void> {
  const { data } = await httpsCallable<{ tier: PaidTier }, { url: string }>(functions, 'createCheckoutSession')({ tier })
  window.location.href = data.url
}

export async function openBillingPortal(): Promise<void> {
  const { data } = await httpsCallable<void, { url: string }>(functions, 'createPortalSession')()
  window.location.href = data.url
}

// User-facing copy for a failed checkout / portal call.
export function billingErrorMessage(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : ''
  if (code === 'functions/already-exists') return 'You already have a subscription — use Manage subscription to change plans.'
  if (code === 'functions/unauthenticated') return 'Sign in to subscribe.'
  return "Couldn't reach checkout. Try again."
}
