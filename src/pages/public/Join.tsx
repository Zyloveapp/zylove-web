import { Link } from 'react-router-dom'
import PublicLayout from '../../components/public/PublicLayout'
import FoundingCounter from '../../components/public/FoundingCounter'

const BENEFITS = [
  {
    title: 'Founding member for life',
    body: 'Lifetime free access and a permanent founding badge. No trials, no billing, no catch — ever.',
  },
  { title: 'First in the queue', body: "You'll be among the first profiles seen when we go live in Austin." },
  { title: 'Founding member badge', body: 'A permanent mark on your profile. You were here at the very beginning.' },
  { title: 'Direct line to the founder', body: 'A real voice. A real conversation. Your feedback shapes the product.' },
]

const STATS = [
  { value: '100', label: 'Founding spots — Austin only' },
  { value: '0', label: 'Unsolicited photos — impossible by design' },
  { value: '$0', label: 'Cost to founding members — ever' },
]

// The Austin founding circle (was zylove-website/founding.html). Membership
// is automatic now (assignFounderBadge at the end of onboarding), so this page
// sends people to sign up rather than collecting applications.
export default function Join() {
  return (
    <PublicLayout>
      <section className="text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-[#7C9BFF]">Austin founding circle · 2026</p>
        <h1 className="mt-3 text-4xl font-black leading-tight sm:text-5xl">
          Be part of the shift in <span className="text-[#1B4FD8]">dating culture</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-white/60">
          Dating fatigue is real. The apps aren't working. <strong className="text-white">Zylove is built differently</strong> — and
          we're starting with the first 100 founding members in Austin, who help shape what that actually means.
        </p>
      </section>

      <section className="mt-10 grid gap-3 sm:grid-cols-2">
        {BENEFITS.map((b) => (
          <div key={b.title} className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="font-semibold">
              <span className="text-[#1B4FD8]">✦</span> {b.title}
            </p>
            <p className="mt-1 text-sm text-white/60">{b.body}</p>
          </div>
        ))}
      </section>

      <section className="mt-8 grid grid-cols-3 gap-3 text-center">
        {STATS.map((s) => (
          <div key={s.label} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-3xl font-black text-[#1B4FD8]">{s.value}</p>
            <p className="mt-1 text-xs text-white/50">{s.label}</p>
          </div>
        ))}
      </section>

      <section className="mt-10 rounded-2xl border border-[#1B4FD8]/30 bg-[radial-gradient(ellipse_at_top,rgba(27,79,216,0.18),transparent_70%)] p-8 text-center">
        <h2 className="text-2xl font-bold">Founding membership is automatic</h2>
        <p className="mx-auto mt-3 max-w-md text-white/70">
          Sign up at zylove.app and if you're one of the first 100 Austin members, the badge is yours.
        </p>
        <Link
          to="/"
          className="mt-6 inline-block rounded-xl bg-[#1B4FD8] px-8 py-3 font-semibold text-white transition-colors hover:bg-[#1B4FD8]/90"
        >
          Sign up now →
        </Link>
        <FoundingCounter />
      </section>
    </PublicLayout>
  )
}
