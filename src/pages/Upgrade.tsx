import { useEffect } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useBackLinkClass } from '../store/modeStore'
import { useAuthStore } from '../store/authStore'
import { useSubscriptionStore } from '../store/subscriptionStore'
import { TRIAL_DAYS } from '../services/subscription'
import { PLAN_NAMES, type PaidTier } from '../services/billing'
import { useBilling } from '../components/PaywallGate'

const SPARK_PLUS = ['See who liked you', 'Full compatibility reports', 'Encrypted photo sharing', 'Conversation starters', 'Vibe checks']
const ELITE_EXTRAS = ['Play mode', 'Zylove Score', 'Top Picks']

function Plan({
  id,
  name,
  price,
  intro,
  features,
  button,
  accent,
  current,
  busy,
  onClick,
}: {
  id: string
  name: string
  price: string
  intro?: string
  features: string[]
  button: string
  accent: string
  current: boolean
  busy: boolean
  onClick: () => void
}) {
  return (
    <section id={id} className={`scroll-mt-6 rounded-2xl border bg-white/5 p-6 ${current ? 'border-white/40' : 'border-white/10'}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold">{name}</h2>
        <p className="text-sm text-white/70">
          <span className="text-2xl font-bold text-white">{price}</span>/mo
        </p>
      </div>
      {current && <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-emerald-300">Your plan</p>}
      {intro && <p className="mt-4 text-sm text-white/60">{intro}</p>}
      <ul className="mt-3 space-y-2 text-sm">
        {features.map((f) => (
          <li key={f} className="flex gap-2">
            <span className="text-emerald-300" aria-hidden>
              ✓
            </span>
            {f}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onClick}
        disabled={current || busy}
        className="mt-6 w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        style={{ backgroundColor: accent }}
      >
        {busy ? 'Taking you to checkout…' : current ? 'Your plan' : button}
      </button>
    </section>
  )
}

function ManageButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-xl border border-white/20 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/10 disabled:opacity-60"
    >
      {busy ? 'Opening…' : 'Manage subscription'}
    </button>
  )
}

// Plans. Public: signed-out visitors see the plans, signed-in users also see
// their trial, subscription or lifetime access. Stripe Checkout sends people
// back here with ?success=true or ?canceled=true.
export default function Upgrade() {
  const backLinkClass = useBackLinkClass()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { hash } = useLocation()
  const signedIn = useAuthStore((s) => s.user !== null)
  const { tier, daysLeft, alwaysElite, subscriptionStatus, trialEnded } = useSubscriptionStore()
  const { pending, error, checkout, portal } = useBilling()
  // /upgrade#elite (Settings, for Spark+ members): jump to the Elite plan.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth' })
  }, [hash])
  const trialProgress = daysLeft !== null ? Math.min(100, Math.max(0, ((TRIAL_DAYS - daysLeft) / TRIAL_DAYS) * 100)) : 0

  const succeeded = searchParams.get('success') === 'true'
  const canceled = searchParams.get('canceled') === 'true'
  // Still billing (past_due is being retried): plan changes go through the portal.
  const subscribed = subscriptionStatus === 'active' || subscriptionStatus === 'past_due'
  const paidTier: PaidTier | null = tier === 'spark_plus' || tier === 'elite' ? tier : null

  function choose(plan: PaidTier) {
    if (!signedIn) return navigate('/login')
    void (subscribed ? portal() : checkout(plan))
  }

  function buttonFor(plan: PaidTier): string {
    if (!signedIn) return 'Sign in to subscribe'
    return subscribed ? `Switch to ${PLAN_NAMES[plan]}` : `Upgrade to ${PLAN_NAMES[plan]}`
  }

  return (
    <div className="min-h-[100dvh] bg-gray-950 px-4 py-8 text-white">
      <div className="mx-auto max-w-xl space-y-6">
        <button type="button" onClick={() => navigate(-1)} className={`text-sm font-medium ${backLinkClass} hover:text-white`}>
          ← Back
        </button>
        <h1 className="text-3xl font-bold">Zylove plans</h1>

        {succeeded && (
          <section className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-center text-emerald-200">
            {/* The webhook usually lands within seconds; the store updates live. */}
            {subscriptionStatus === 'active' && paidTier
              ? `✦ Welcome to ${PLAN_NAMES[paidTier]}! Your subscription is active.`
              : '✦ Payment received — activating your subscription…'}
          </section>
        )}
        {canceled && !subscribed && <p className="text-center text-sm text-white/50">No worries — your trial continues.</p>}

        {alwaysElite ? (
          <section className="rounded-2xl border border-[#E8B931]/40 bg-[#E8B931]/10 p-6 text-center">
            <p className="text-lg font-semibold">✦ You have lifetime Elite access. Free. Always.</p>
          </section>
        ) : (
          <>
            {subscriptionStatus === 'active' && paidTier && (
              <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-6">
                <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-sm font-semibold text-emerald-200">
                  ✦ You're on {PLAN_NAMES[paidTier]}
                </span>
                <ManageButton busy={pending === 'portal'} onClick={() => void portal()} />
              </section>
            )}
            {subscriptionStatus === 'past_due' && (
              <section className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6">
                <h2 className="text-lg font-bold">Your last payment failed</h2>
                <p className="mt-1 text-sm text-white/70">Update your payment method to keep your plan.</p>
                <div className="mt-4">
                  <ManageButton busy={pending === 'portal'} onClick={() => void portal()} />
                </div>
              </section>
            )}
            {tier === 'trial' && daysLeft !== null && (
              <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6">
                <h2 className="text-lg font-bold">✦ Your free trial</h2>
                <p className="mt-1 text-sm text-white/70">
                  You have {daysLeft} {daysLeft === 1 ? 'day' : 'days'} left of full Elite access.
                </p>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-amber-400" style={{ width: `${trialProgress}%` }} />
                </div>
                <p className="mt-3 text-sm text-white/60">Enjoying Zylove? Upgrade before your trial ends.</p>
              </section>
            )}
            {trialEnded && (
              <section className="rounded-2xl border border-white/15 bg-white/5 p-6">
                <h2 className="text-lg font-bold">Your trial has ended — subscribe to continue</h2>
              </section>
            )}
            {error && <p className="text-center text-sm text-red-400">{error}</p>}
            <Plan
              id="spark-plus"
              name="Spark+"
              price="$14.99"
              features={SPARK_PLUS}
              button={buttonFor('spark_plus')}
              accent="#1B4FD8"
              current={tier === 'spark_plus'}
              busy={pending === 'spark_plus'}
              onClick={() => choose('spark_plus')}
            />
            <Plan
              id="elite"
              name="Elite"
              price="$30"
              intro="Everything in Spark+ plus:"
              features={ELITE_EXTRAS}
              button={buttonFor('elite')}
              accent="#E03131"
              current={tier === 'elite'}
              busy={pending === 'elite'}
              onClick={() => choose('elite')}
            />
          </>
        )}

        <p className="text-center text-xs text-white/40">Payments are handled securely by Stripe. Cancel anytime.</p>
        {!signedIn && (
          <p className="text-center text-sm">
            <Link to="/login" className="text-[#7C9BFF] hover:text-white">
              Sign in to see your plan →
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}
