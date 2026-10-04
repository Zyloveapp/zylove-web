import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { doc, onSnapshot, type DocumentData } from 'firebase/firestore'
import { db } from '../services/firebase'
import { getDaysLeftInTrial, getSubscriptionStatus, hasEliteIdentity, hasTrialEnded } from '../services/subscription'
import { useBilling } from './PaywallGate'

const SUBLABEL_TOP = "You've got the best of Zylove. Nothing more to unlock. 😈"

const BORDER = {
  cobalt: 'border-[#1B4FD8]',
  red: 'border-[#E03131]',
  amber: 'border-amber-500',
} as const

interface Row {
  label: string
  sublabel: string
  border: keyof typeof BORDER
  // Paid Elite gets a faint cobalt wash.
  shimmer?: boolean
  action: 'upgrade' | 'upgrade-elite' | 'portal' | null
}

// First match wins: founder, complimentary (gender), paid Elite, paid Spark+,
// failed payment, trial, trial over.
function membershipRow(user: DocumentData): Row {
  const status = getSubscriptionStatus(user)
  if (user.isFounder === true) {
    const badge = typeof user.founderBadge === 'string' && user.founderBadge ? user.founderBadge : 'Austin Founder'
    const hasCustomer = typeof user.stripeCustomerId === 'string' && user.stripeCustomerId !== ''
    return { label: `✦ ${badge} · Elite`, sublabel: SUBLABEL_TOP, border: 'cobalt', action: hasCustomer ? 'portal' : null }
  }
  if (hasEliteIdentity(user)) {
    return { label: '✦ Elite · Complimentary', sublabel: "You've got the best of Zylove. Nothing more to unlock.", border: 'cobalt', action: null }
  }
  if (user.subscriptionTier === 'elite' && status === 'active') {
    return { label: '✦ Elite', sublabel: SUBLABEL_TOP, border: 'cobalt', shimmer: true, action: 'portal' }
  }
  if (user.subscriptionTier === 'spark_plus' && status === 'active') {
    return { label: '✦ Spark+', sublabel: 'Upgrade to Elite for Play access →', border: 'cobalt', action: 'upgrade-elite' }
  }
  if (status === 'past_due') {
    return { label: '⚠ Payment failed', sublabel: 'Update your payment method →', border: 'amber', action: 'portal' }
  }
  // A plan granted outside Stripe (no subscriptionStatus): show it, nothing to manage.
  if (user.subscriptionTier === 'elite') return { label: '✦ Elite', sublabel: SUBLABEL_TOP, border: 'cobalt', shimmer: true, action: null }
  if (user.subscriptionTier === 'spark_plus') {
    return { label: '✦ Spark+', sublabel: 'Upgrade to Elite for Play access →', border: 'cobalt', action: 'upgrade-elite' }
  }
  if (hasTrialEnded(user)) {
    return { label: '✦ Free · Trial ended', sublabel: 'Subscribe to continue →', border: 'red', action: 'upgrade' }
  }
  const days = getDaysLeftInTrial(user)
  return {
    label: days === null ? '✦ Free trial' : `✦ Free · ${days} ${days === 1 ? 'day' : 'days'} remaining`,
    sublabel: 'Upgrade to unlock everything →',
    border: 'cobalt',
    action: 'upgrade',
  }
}

// Settings → Membership: the user's plan, with the one thing to do about it
// (upgrade, fix a payment, or manage in Stripe's Customer Portal).
export default function MembershipSection({ uid }: { uid: string }) {
  const navigate = useNavigate()
  const { pending, error, portal } = useBilling()
  const [user, setUser] = useState<{ uid: string; data: DocumentData } | null>(null)

  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      doc(db, 'users', uid),
      (snap) => setUser({ uid, data: snap.data() ?? {} }),
      () => setUser(null),
    )
  }, [uid])

  if (user?.uid !== uid) return null
  const row = membershipRow(user.data)

  function tap() {
    if (row.action === 'upgrade') navigate('/upgrade')
    else if (row.action === 'upgrade-elite') navigate('/upgrade#elite')
    else if (row.action === 'portal') void portal()
  }

  const body = (
    <>
      <span className="min-w-0">
        <span className="block font-medium text-white">{row.label}</span>
        <span className="block text-sm text-white/50">{pending === 'portal' ? 'Opening…' : row.sublabel}</span>
      </span>
      {row.action && (
        <span className="text-white/30" aria-hidden>
          ›
        </span>
      )}
    </>
  )
  const cls = `flex w-full items-center justify-between gap-4 rounded-lg border-l-2 px-4 py-3 text-left ${BORDER[row.border]} ${
    row.shimmer ? 'bg-gradient-to-r from-[#1B4FD8]/15 to-white/5' : 'bg-white/5'
  }`

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">Membership</h2>
      {row.action ? (
        <button type="button" onClick={tap} disabled={pending !== null} className={`${cls} transition-colors hover:bg-white/10 disabled:opacity-60`}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  )
}
