import { useState, type FormEvent } from 'react'
import PublicLayout from '../../components/public/PublicLayout'
import { MAX_LONG, MAX_SHORT, applyFounding, joinWaitlist, normalizeEmail, type SubmitResult } from '../../services/publicForms'

const BENEFITS = [
  { title: 'Elite access, forever free', body: 'Every premium feature, for life. No trials, no billing, no catch — ever.' },
  { title: 'First in the queue', body: "You'll be among the first profiles seen when we go live in Austin." },
  { title: 'Founding member badge', body: 'A permanent mark on your profile. You were here at the very beginning.' },
  { title: 'Direct line to the founder', body: 'A real voice. A real conversation. Your feedback shapes the product.' },
]

const STATS = [
  { value: '50', label: 'Founding spots — Austin only' },
  { value: '0', label: 'Unsolicited photos — impossible by design' },
  { value: '$0', label: 'Cost to founding members — ever' },
]

const input =
  'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:border-[#1B4FD8]/60 focus:outline-none'

function resultMessage(r: SubmitResult): string {
  return r === 'duplicate-or-denied'
    ? "Couldn't submit — this email may already be on the list."
    : "Couldn't submit right now. Check your connection and try again."
}

function FoundingForm() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [instagram, setInstagram] = useState('')
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const normalized = normalizeEmail(email)
    if (!name.trim() || !normalized) return setError('Add your first name and a valid email.')
    setBusy(true)
    setError(null)
    const result = await applyFounding({ name, email: normalized, instagram, why })
    setBusy(false)
    if (result === 'ok') setDone(true)
    else setError(resultMessage(result))
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-[#1B4FD8]/40 bg-[#1B4FD8]/10 p-6 text-center">
        <p className="text-lg font-semibold">Application received ✦</p>
        <p className="mt-2 text-white/60">Thank you — we'll be in touch.</p>
        <p className="mt-1 text-sm text-white/40">Matthew reviews every application personally. You'll hear back within 48 hours.</p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_SHORT} placeholder="Your first name" autoComplete="given-name" />
      <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" autoComplete="email" />
      <input className={input} value={instagram} onChange={(e) => setInstagram(e.target.value)} maxLength={MAX_SHORT} placeholder="Instagram handle (optional)" />
      <textarea
        className={`${input} resize-none`}
        rows={3}
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        maxLength={MAX_LONG}
        placeholder="What does better dating look like to you? (optional)"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button type="submit" disabled={busy} className="w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold transition-opacity hover:opacity-90 disabled:opacity-50">
        {busy ? 'Sending…' : 'Join the founding circle'}
      </button>
      <p className="text-center text-xs text-white/40">No spam, ever · Private &amp; secure · Austin women only</p>
    </form>
  )
}

function WaitlistForm() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const normalized = normalizeEmail(email)
    if (!normalized) return setError('Enter a valid email.')
    setBusy(true)
    setError(null)
    const result = await joinWaitlist(normalized)
    setBusy(false)
    if (result === 'ok') setDone(true)
    else setError(resultMessage(result))
  }

  if (done) return <p className="text-center font-medium text-[#B4C6FF]">Thank you — we'll be in touch ✦</p>

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
      <input className={`${input} sm:w-auto sm:flex-1`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" autoComplete="email" />
      <button type="submit" disabled={busy} className="shrink-0 rounded-xl border border-white/20 px-6 py-3 font-semibold text-white/80 hover:bg-white/5 disabled:opacity-50">
        {busy ? 'Joining…' : 'Join the waitlist →'}
      </button>
      {error && <p className="text-sm text-red-400 sm:basis-full">{error}</p>}
    </form>
  )
}

// The Austin founding circle (was zylove-website/founding.html).
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
          we're starting in Austin with 50 founding women who help shape what that actually means.
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

      <section className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-6">
        <h2 className="text-2xl font-bold">Claim your founding spot</h2>
        <p className="mt-1 mb-5 text-sm text-white/50">We review every application personally and follow up within 48 hours.</p>
        <FoundingForm />
      </section>

      <section className="mt-10">
        <p className="text-center text-white/60">
          Ladies first. The waitlist is open for everyone else — and trust us, you'll be glad we did it this way.
        </p>
        <div className="mt-4">
          <WaitlistForm />
        </div>
      </section>
    </PublicLayout>
  )
}
