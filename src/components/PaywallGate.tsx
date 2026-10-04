import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useSubscriptionStore } from '../store/subscriptionStore'
import { canAccess, type Feature } from '../services/subscription'
import { billingErrorMessage, openBillingPortal, startCheckout, type PaidTier } from '../services/billing'

export const PAYWALL_COPY: Partial<Record<Feature, { title: string; body: string; button: string }>> = {
  sparks: {
    title: '✦ See who likes you',
    body: "Upgrade to Spark+ to unlock your Sparks and see who's interested.",
    button: 'Upgrade to Spark+',
  },
  compatibility: {
    title: '✦ Your compatibility report is ready',
    body: 'Upgrade to Spark+ to reveal your full compatibility breakdown.',
    button: 'Upgrade to Spark+',
  },
  photo_sharing: {
    title: '🔒 Share photos privately',
    body: 'Upgrade to Spark+ to send encrypted photos in your conversations.',
    button: 'Upgrade to Spark+',
  },
  play_mode: {
    title: '🔥 Unlock Play mode',
    body: 'Play mode is available with Elite. Upgrade to access a different side of Zylove.',
    button: 'Upgrade to Elite',
  },
  zylove_score: {
    title: '🛡 Your Zylove Score',
    body: 'See how matches experience you. Available with Spark+.',
    button: 'Upgrade to Spark+',
  },
}

// True / false once the tier has loaded; null while it's loading.
export function useCanAccess(feature: Feature): boolean | null {
  const tier = useSubscriptionStore((s) => s.tier)
  return tier === null ? null : canAccess(tier, feature)
}

// Stripe Checkout / Customer Portal redirects. `pending` names what's loading
// and stays set while the browser leaves for Stripe.
export function useBilling() {
  const [pending, setPending] = useState<PaidTier | 'portal' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Back from Stripe via the back button restores this page from the bfcache
  // with the spinner still on; clear it.
  useEffect(() => {
    function onShow(e: PageTransitionEvent) {
      if (e.persisted) setPending(null)
    }
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [])

  async function run(which: PaidTier | 'portal', go: () => Promise<void>) {
    if (pending) return
    setPending(which)
    setError(null)
    try {
      await go()
    } catch (err) {
      setError(billingErrorMessage(err))
      setPending(null)
    }
  }

  return {
    pending,
    error,
    checkout: (tier: PaidTier) => run(tier, () => startCheckout(tier)),
    portal: () => run('portal', openBillingPortal),
  }
}

export function PaywallCard({ feature, teaser, onClose }: { feature: Feature; teaser?: ReactNode; onClose?: () => void }) {
  const copy = PAYWALL_COPY[feature] ?? { title: '✦ Upgrade', body: 'This is part of a Zylove plan.', button: 'Upgrade to Spark+' }
  const red = feature === 'play_mode'
  const plan: PaidTier = red ? 'elite' : 'spark_plus'
  // Already paying (Spark+ reaching for Play): change plans in the portal
  // rather than starting a second subscription.
  const subscribed = useSubscriptionStore((s) => s.subscriptionStatus === 'active' || s.subscriptionStatus === 'past_due')
  const { pending, error, checkout, portal } = useBilling()
  return (
    <div className="mx-auto w-full max-w-sm rounded-2xl border border-white/10 bg-gray-900 px-6 py-8 text-center text-white shadow-xl">
      {teaser && <div className="mb-6">{teaser}</div>}
      <h2 className="text-xl font-bold">{copy.title}</h2>
      <p className="mt-2 text-sm text-white/60">{copy.body}</p>
      <button
        type="button"
        onClick={() => void (subscribed ? portal() : checkout(plan))}
        disabled={pending !== null}
        className={`mt-6 w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60 ${
          red ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
        }`}
      >
        {pending ? 'Taking you to checkout…' : copy.button}
      </button>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <Link to="/upgrade" className="mt-3 block text-xs text-white/50 hover:text-white">
        Compare plans
      </Link>
      {onClose && (
        <button type="button" onClick={onClose} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
          Not now
        </button>
      )}
    </div>
  )
}

// Full-screen version for actions (opening Play, sending a photo).
export function PaywallModal({ feature, onClose }: { feature: Feature; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full">
        <PaywallCard feature={feature} onClose={onClose} />
      </div>
    </div>
  )
}

interface PaywallGateProps {
  feature: Feature
  children: ReactNode
  // Shown above the upgrade copy when locked (e.g. a blurred preview).
  teaser?: ReactNode
  // Rendered while the tier is loading; nothing by default.
  loading?: ReactNode
}

// Children when the user's tier includes `feature`, otherwise an upgrade card.
export default function PaywallGate({ feature, children, teaser, loading = null }: PaywallGateProps) {
  const allowed = useCanAccess(feature)
  if (allowed === null) return <>{loading}</>
  if (allowed) return <>{children}</>
  return (
    <div className="py-8">
      <PaywallCard feature={feature} teaser={teaser} />
    </div>
  )
}
