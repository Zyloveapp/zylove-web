import { useState, type FormEvent } from 'react'
import PublicLayout from '../../components/public/PublicLayout'
import { MAX_LONG, MAX_SHORT, normalizeEmail, sendContactMessage } from '../../services/publicForms'

const TOPICS = ['Founding circle', 'Press or media', 'Partnership', 'Feedback or ideas', 'Just saying hello']

const input =
  'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:border-[#1B4FD8]/60 focus:outline-none'

// Was zylove-website/contact.html.
export default function Contact() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [topic, setTopic] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const normalized = normalizeEmail(email)
    if (!name.trim() || !normalized || !message.trim()) return setError('Add your name, a valid email and a message.')
    setBusy(true)
    setError(null)
    const result = await sendContactMessage({ name, email: normalized, topic, message })
    setBusy(false)
    if (result === 'ok') setDone(true)
    else setError("Couldn't send right now. Try again, or email hello@zylove.app.")
  }

  return (
    <PublicLayout>
      <section className="text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-[#7C9BFF]">Get in touch</p>
        <h1 className="mt-3 text-4xl font-black leading-tight sm:text-5xl">
          We'd love to <span className="text-[#1B4FD8]">hear from you</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-white/60">
          Follow along, reach out directly, or drop us a message below. We're building this in public and your voice matters.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-white/40">Follow us</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <a href="https://instagram.com/zylove.app" target="_blank" rel="noreferrer" className="rounded-2xl border border-white/10 bg-white/5 p-5 hover:border-white/25">
            <p className="font-semibold">Instagram</p>
            <p className="text-sm text-white/50">@zylove.app</p>
          </a>
          <a href="https://tiktok.com/@zylove.app" target="_blank" rel="noreferrer" className="rounded-2xl border border-white/10 bg-white/5 p-5 hover:border-white/25">
            <p className="font-semibold">TikTok</p>
            <p className="text-sm text-white/50">@zylove.app</p>
          </a>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-white/40">Reach out directly</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="text-xs uppercase tracking-widest text-[#7C9BFF]">Founding circle</p>
            <p className="mt-1 font-semibold">Questions about founding?</p>
            <p className="mt-1 text-sm text-white/60">
              Curious about what it means to be a founding member, how it works, or whether it's right for you.
            </p>
            <a href="mailto:founders@zylove.app" className="mt-3 inline-block text-sm font-medium text-[#7C9BFF] hover:text-white">
              founders@zylove.app →
            </a>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="text-xs uppercase tracking-widest text-[#7C9BFF]">General</p>
            <p className="mt-1 font-semibold">Everything else</p>
            <p className="mt-1 text-sm text-white/60">Press, partnerships, ideas, feedback, or just want to say hello. We read everything.</p>
            <a href="mailto:hello@zylove.app" className="mt-3 inline-block text-sm font-medium text-[#7C9BFF] hover:text-white">
              hello@zylove.app →
            </a>
          </div>
        </div>
      </section>

      <section className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-6">
        <h2 className="text-xl font-bold">Or fill out the form below</h2>
        {done ? (
          <div className="mt-4 text-center">
            <p className="text-lg font-semibold">Message received.</p>
            <p className="mt-1 text-white/60">Thank you — we'll be in touch.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-3">
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_SHORT} placeholder="Your name" autoComplete="name" />
            <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" autoComplete="email" />
            <select className={`${input} bg-gray-900`} value={topic} onChange={(e) => setTopic(e.target.value)}>
              <option value="">What's this about?</option>
              {TOPICS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <textarea className={`${input} resize-none`} rows={5} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={MAX_LONG} placeholder="Your message" />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button type="submit" disabled={busy} className="w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold transition-opacity hover:opacity-90 disabled:opacity-50">
              {busy ? 'Sending…' : 'Send message'}
            </button>
            <p className="text-center text-xs text-white/40">We read everything · We'll get back to you</p>
          </form>
        )}
      </section>
    </PublicLayout>
  )
}
