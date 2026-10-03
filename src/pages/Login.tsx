import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { signInWithEmailAndPassword, type ConfirmationResult } from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import { checkPhoneNumber, clearRecaptcha, confirmOtp, initRecaptcha, sendOtp } from '../services/auth'
import { auth } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import PublicFooter from '../components/public/PublicFooter'
import Wordmark from '../components/public/Wordmark'
import FoundingCounter from '../components/public/FoundingCounter'
import { requestLocation, saveUserLocation } from '../services/location'

// US numbers only: the field shows a fixed +1 and holds just the 10 digits.
// Pasting "+1 555…" or "1555…" drops the leading country code.
function nationalDigits(input: string): string {
  const digits = input.replace(/\D/g, '')
  return (digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits).slice(0, 10)
}

// (555) 123-4567, built up as they type.
function formatPhone(d: string): string {
  if (d.length <= 3) return d.length ? `(${d}` : ''
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

function toE164(digits: string): string | null {
  return /^\d{10}$/.test(digits) ? `+1${digits}` : null
}

const ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-phone-number': 'That phone number isn\'t valid.',
  'auth/missing-phone-number': 'Enter your phone number.',
  'auth/too-many-requests': 'Too many attempts. Try again later.',
  'auth/quota-exceeded': 'SMS limit reached. Try again later.',
  'auth/captcha-check-failed': 'Verification check failed. Try again.',
  'auth/invalid-verification-code': 'That code is incorrect.',
  'auth/missing-verification-code': 'Enter the 6-digit code.',
  'auth/code-expired': 'That code has expired. Request a new one.',
  'auth/network-request-failed': 'Network error. Check your connection.',
}

function errorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    return ERROR_MESSAGES[err.code] ?? `Something went wrong (${err.code}).`
  }
  if (err instanceof Error) return err.message
  return 'Something went wrong. Try again.'
}

const FEATURES = [
  {
    icon: '✦',
    title: 'Real compatibility',
    body: 'Not just photos. A full scorecard built from who you actually are.',
  },
  { icon: '🔒', title: 'Private by design', body: 'End-to-end encrypted conversations. Consent-based photos.' },
  {
    icon: '🔥',
    title: 'Two worlds, one app',
    body: 'Spark for something real. Play for something honest. Both on your terms.',
  },
]

const FOUNDING_BENEFITS = ['Founding member for life', 'First in the queue', 'Founding badge', 'Direct line to Matthew']

const STATS = [
  { value: '2', label: 'modes' },
  { value: 'Free', label: 'to join' },
  { value: '2026', label: 'Austin launch' },
]

// Phone sign-in (OTP). Signing in and signing up are the same flow: a new
// number lands in onboarding via AuthGuard.
function SignInCard() {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Which step of sending a code is running, for the button label.
  const [sendStep, setSendStep] = useState<'verifying' | 'sending'>('sending')

  // Dev-only shortcut past phone auth. Defined behind the DEV check so the
  // handler and its credentials are dropped from production builds entirely.
  const handleDevLogin = import.meta.env.DEV
    ? async () => {
        const email = import.meta.env.VITE_DEV_EMAIL
        const password = import.meta.env.VITE_DEV_PASSWORD
        if (!email || !password) {
          setError('Set VITE_DEV_EMAIL and VITE_DEV_PASSWORD in .env.local.')
          return
        }
        setError(null)
        setSubmitting(true)
        try {
          await signInWithEmailAndPassword(auth, email, password)
          navigate('/discover', { replace: true })
        } catch (err) {
          setError(errorMessage(err))
          setSubmitting(false)
        }
      }
    : null

  useEffect(() => {
    initRecaptcha()
    return clearRecaptcha
  }, [])

  async function handleSendCode(e: FormEvent) {
    e.preventDefault()
    setError(null)

    const e164 = toE164(phone)
    if (!e164) {
      setError('Enter your 10-digit phone number, e.g. (555) 123-4567.')
      return
    }

    setSubmitting(true)
    try {
      setSendStep('verifying')
      if (!(await checkPhoneNumber(e164))) {
        setError("This number type isn't supported. Please use a mobile phone number to sign up for Zylove.")
        return
      }
      setSendStep('sending')
      setConfirmation(await sendOtp(e164))
      setCode('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault()
    if (!confirmation) return
    setError(null)

    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code.')
      return
    }

    setSubmitting(true)
    try {
      const { user } = await confirmOtp(confirmation, code)
      // Fire and forget: location never blocks sign-in, and a denial is silent.
      void requestLocation().then((loc) => (loc ? saveUserLocation(user.uid, loc) : undefined)).catch(() => {})
      navigate('/discover', { replace: true })
    } catch (err) {
      setError(errorMessage(err))
      setSubmitting(false)
    }
  }

  function handleChangeNumber() {
    setConfirmation(null)
    setCode('')
    setError(null)
  }

  const inputClass =
    'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white placeholder:text-white/30 focus:border-[#1B4FD8]/60 focus:outline-none'
  const buttonClass =
    'w-full rounded-xl bg-[#1B4FD8] px-4 py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40'

  return (
    <div id="signin" className="w-full max-w-sm scroll-mt-8 rounded-2xl border border-white/10 bg-white/5 p-6 text-left">
      {!confirmation ? (
        <form onSubmit={handleSendCode} className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Sign in or join</h2>
            <p className="text-sm text-white/40">We'll text you a code.</p>
          </div>
          <label className="block space-y-1">
            <span className="text-sm text-white/60">Phone number</span>
            <div className="flex items-center rounded-xl border border-white/10 bg-white/5 focus-within:border-[#1B4FD8]/60">
              <span className="select-none border-r border-white/10 py-3 pl-4 pr-3 text-base text-white/60" aria-hidden>
                +1
              </span>
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                aria-label="Phone number (US)"
                value={formatPhone(phone)}
                onChange={(e) => setPhone(nationalDigits(e.target.value))}
                placeholder="(555) 123-4567"
                className="min-w-0 flex-1 bg-transparent px-3 py-3 text-base text-white placeholder:text-white/30 focus:outline-none"
              />
            </div>
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {/* Always full strength: the form is the page's call to action.
              An incomplete number gets a message on submit instead. */}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-[#1B4FD8] px-4 py-3 font-semibold text-white transition-colors hover:bg-[#1B4FD8]/90"
          >
            {submitting ? (sendStep === 'verifying' ? 'Verifying number…' : 'Sending…') : 'Send code'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerify} className="space-y-4">
          <h2 className="text-lg font-semibold text-white">Enter your code</h2>
          <p className="text-sm text-white/60">We texted a 6-digit code to +1 {formatPhone(phone)}.</p>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="123456"
            className={`${inputClass} tracking-widest`}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button type="submit" disabled={submitting || code.length !== 6} className={buttonClass}>
            {submitting ? 'Verifying…' : 'Verify'}
          </button>
          <button
            type="button"
            onClick={handleChangeNumber}
            disabled={submitting}
            className="w-full text-sm text-white/50 underline hover:text-white"
          >
            Use a different number
          </button>
        </form>
      )}
      {import.meta.env.DEV && handleDevLogin && (
        <button
          type="button"
          onClick={handleDevLogin}
          disabled={submitting}
          className="mt-4 w-full rounded-xl border border-dashed border-white/20 px-4 py-1.5 text-sm text-white/50 disabled:opacity-50"
        >
          Dev login
        </button>
      )}
      {/* Mount point for the invisible reCAPTCHA; renders nothing visible. */}
      <div id="recaptcha-container" />
    </div>
  )
}

// Landing page with sign-in built in, served at / and /login. Signed-in
// users go straight to Discover.
export default function Login() {
  const user = useAuthStore((s) => s.user)
  const loading = useAuthStore((s) => s.loading)

  // Blank (same background) while auth resolves, so signed-in users never
  // see the landing page flash before the redirect.
  if (loading) return <div className="min-h-screen bg-gray-950" />
  if (user) return <Navigate to="/discover" replace />

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Hero */}
      <section className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden px-4 py-16 text-center">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[70vh] bg-[radial-gradient(ellipse_at_top,rgba(27,79,216,0.28),transparent_65%)]"
          aria-hidden
        />
        <div className="relative flex w-full flex-col items-center">
          <h1 className="text-5xl">
            <Wordmark />
          </h1>
          <p className="mt-3 text-2xl text-white/80">Match your energy.</p>
          <p className="mt-1 text-white/50">Dating fatigue is real. The apps aren't working.</p>

          {/* The form is the call to action. */}
          <div className="mt-6 flex w-full justify-center">
            <SignInCard />
          </div>

          <p className="mt-5 text-sm text-[#7C9BFF]">First 100 founding members in Austin</p>
          <a href="#features" className="mt-3 text-sm text-white/40 transition-colors hover:text-white/70">
            Learn more ↓
          </a>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-4 px-4 py-20">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center text-3xl font-bold">Why Zylove is different</h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <p className="text-2xl text-[#1B4FD8]" aria-hidden>
                  {f.icon}
                </p>
                <p className="mt-3 font-semibold">{f.title}</p>
                <p className="mt-1 text-sm text-white/60">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Two modes */}
      <section className="px-4 py-16">
        <div className="mx-auto grid max-w-4xl gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-[#1B4FD8]/40 bg-[#1B4FD8]/10 p-6">
            <p className="text-2xl font-bold">
              <span className="text-[#1B4FD8]">✦</span> Spark
            </p>
            <p className="mt-2 text-white/70">Serious dating. Real compatibility. Something worth keeping.</p>
          </div>
          <div className="rounded-2xl border border-[#E03131]/40 bg-[#E03131]/10 p-6">
            <p className="text-2xl font-bold">🔴 Play</p>
            <p className="mt-2 text-white/70">A different side of Zylove. Honest. Adult. On your terms.</p>
          </div>
        </div>
      </section>

      {/* Founding circle */}
      <section className="px-4 py-16">
        <div className="mx-auto max-w-2xl rounded-2xl border border-white/10 bg-[radial-gradient(ellipse_at_top,rgba(27,79,216,0.18),transparent_70%)] p-8 text-center">
          <h2 className="text-3xl font-bold">
            <span className="text-[#1B4FD8]">✦</span> Austin Founding Circle
          </h2>
          <p className="mt-3 text-lg text-white/70">First 100 founding members in Austin. Lifetime free access. The reason it works.</p>
          <p className="mt-2 text-sm text-white/50">
            Sign up now — founding badges are assigned automatically to the first 100 Austin members.
          </p>
          <ul className="mt-6 flex flex-wrap justify-center gap-2">
            {FOUNDING_BENEFITS.map((b) => (
              <li key={b} className="rounded-full border border-[#1B4FD8]/40 bg-[#1B4FD8]/15 px-4 py-1.5 text-sm text-[#B4C6FF]">
                {b}
              </li>
            ))}
          </ul>
          <Link to="/join" className="mt-8 inline-block font-semibold text-[#7C9BFF] hover:text-white">
            Learn more about the founding circle →
          </Link>
          <FoundingCounter />
        </div>
      </section>

      {/* Stats */}
      <section className="px-4 pb-20">
        <div className="mx-auto grid max-w-2xl grid-cols-3 gap-3 text-center">
          {STATS.map((s) => (
            <div key={s.label} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-3xl font-black text-[#1B4FD8]">{s.value}</p>
              <p className="mt-1 text-sm text-white/50">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      <PublicFooter />
    </div>
  )
}
