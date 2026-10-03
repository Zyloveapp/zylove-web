import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useSubscriptionStore } from '../store/subscriptionStore'
import { TRIAL_DAYS } from '../services/subscription'

const SPARK_PLUS = ['See who liked you', 'Full compatibility reports', 'Encrypted photo sharing', 'Conversation starters', 'Vibe checks']
const ELITE_EXTRAS = ['Play mode', 'Zylove Score', 'Top Picks']

function Plan({
  name,
  price,
  intro,
  features,
  button,
  accent,
  current,
}: {
  name: string
  price: string
  intro?: string
  features: string[]
  button: string
  accent: string
  current: boolean
}) {
  return (
    <section className={`rounded-2xl border bg-white/5 p-6 ${current ? 'border-white/40' : 'border-white/10'}`}>
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
        disabled
        className="mt-6 w-full cursor-not-allowed rounded-xl py-3 font-semibold text-white opacity-60"
        style={{ backgroundColor: accent }}
      >
        {button} · Coming soon
      </button>
    </section>
  )
}

// Plans. Public: signed-out visitors see the plans, signed-in users also see
// their trial or lifetime access. Payments aren't live yet.
export default function Upgrade() {
  const navigate = useNavigate()
  const signedIn = useAuthStore((s) => s.user !== null)
  const { tier, daysLeft, alwaysElite } = useSubscriptionStore()
  const trialProgress = daysLeft !== null ? Math.min(100, Math.max(0, ((TRIAL_DAYS - daysLeft) / TRIAL_DAYS) * 100)) : 0

  return (
    <div className="min-h-[100dvh] bg-gray-950 px-4 py-8 text-white">
      <div className="mx-auto max-w-xl space-y-6">
        <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-[#7C9BFF] hover:text-white">
          ← Back
        </button>
        <h1 className="text-3xl font-bold">Zylove plans</h1>

        {alwaysElite ? (
          <section className="rounded-2xl border border-[#E8B931]/40 bg-[#E8B931]/10 p-6 text-center">
            <p className="text-lg font-semibold">✦ You have lifetime Elite access. Free. Always.</p>
          </section>
        ) : (
          <>
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
            <Plan
              name="Spark+"
              price="$14.99"
              features={SPARK_PLUS}
              button="Upgrade to Spark+"
              accent="#1B4FD8"
              current={tier === 'spark_plus'}
            />
            <Plan
              name="Elite"
              price="$30"
              intro="Everything in Spark+ plus:"
              features={ELITE_EXTRAS}
              button="Upgrade to Elite"
              accent="#E03131"
              current={tier === 'elite'}
            />
          </>
        )}

        <p className="text-center text-xs text-white/40">
          Stripe payments coming soon. Your trial access continues until payments launch.
        </p>
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
