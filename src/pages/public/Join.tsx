import { Link } from 'react-router-dom'
import PublicLayout from '../../components/public/PublicLayout'
import FoundingCounter from '../../components/public/FoundingCounter'
import { FOUNDER_CAPACITY_PER_CITY, FOUNDER_TERMS_SHORT } from '../../config/founderCopy'
import { cityList, useOpenCities } from '../../services/openCities'

// Same offer as FOUNDER_BENEFITS (config/founderCopy), with a line of detail each.
const BENEFITS = [
  { title: 'Elite access, free', body: "No trial, no billing — free for as long as you're a founder." },
  { title: 'Founder badge', body: 'Your city\'s Founder badge on your profile. You were here at the very beginning.' },
  { title: 'Influence with the creator of Zylove to make it better', body: 'A real voice. A real conversation. Your feedback shapes the product.' },
  { title: 'First in line for new features', body: 'New features reach founders first.' },
]

const STATS = [
  { value: String(FOUNDER_CAPACITY_PER_CITY), label: 'Founding spots in each launch city' },
  { value: '0', label: 'Unsolicited photos — impossible by design' },
  { value: '$0', label: "For Elite, while you're a founder" },
]

// The founding circles (was zylove-website/founding.html). Membership is an
// opt-in invitation (offered during onboarding in a launch city with a spot
// open), so this page sends people to sign up rather than collecting
// applications.
export default function Join() {
  // UPDATE 6: name the open (Founding/Live) cities.
  const openCities = useOpenCities()
  return (
    <PublicLayout title="Founding circle · Zylove">
      <section className="text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-[#7C9BFF]">Founding circles · 2026</p>
        <h1 className="mt-3 text-4xl font-black leading-tight sm:text-5xl">
          Be part of the shift in <span className="text-[#1B4FD8]">dating culture</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-white/60">
          Dating fatigue is real. The apps aren't working. <strong className="text-white">Zylove is built differently</strong> — and
          we're launching in {cityList(openCities)} first. Each city starts with {FOUNDER_CAPACITY_PER_CITY} founding members (50 women and 50 men) who
          help shape what that actually means.
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
        <h2 className="text-2xl font-bold">Founding membership is by invitation</h2>
        <p className="mx-auto mt-3 max-w-md text-white/70">
          Sign up at zylove.app. If you're in a launch city and a founding spot is open, you'll be invited to join your city's
          founding circle — accept, and the spot is yours.
        </p>
        <p className="mx-auto mt-3 max-w-md text-sm text-white/50">{FOUNDER_TERMS_SHORT}</p>
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
