import { useEffect, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSubscriptionStore } from '../store/subscriptionStore'
import { canAccess, type Feature } from '../services/subscription'

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

export function PaywallCard({ feature, teaser, onClose }: { feature: Feature; teaser?: ReactNode; onClose?: () => void }) {
  const navigate = useNavigate()
  const copy = PAYWALL_COPY[feature] ?? { title: '✦ Upgrade', body: 'This is part of a Zylove plan.', button: 'See plans' }
  const red = feature === 'play_mode'
  return (
    <div className="mx-auto w-full max-w-sm rounded-2xl border border-white/10 bg-gray-900 px-6 py-8 text-center text-white shadow-xl">
      {teaser && <div className="mb-6">{teaser}</div>}
      <h2 className="text-xl font-bold">{copy.title}</h2>
      <p className="mt-2 text-sm text-white/60">{copy.body}</p>
      <button
        type="button"
        onClick={() => navigate('/upgrade')}
        className={`mt-6 w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 ${
          red ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
        }`}
      >
        {copy.button}
      </button>
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
