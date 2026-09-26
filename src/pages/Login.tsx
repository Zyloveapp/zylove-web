import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { signInWithEmailAndPassword, type ConfirmationResult } from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import { clearRecaptcha, confirmOtp, initRecaptcha, sendOtp } from '../services/auth'
import { auth } from '../services/firebase'

// Accepts "+<country><number>" as-is; bare 10-digit or 1-prefixed 11-digit
// numbers are treated as US. Returns null if it can't be made valid E.164.
function toE164(input: string): string | null {
  const trimmed = input.trim()
  const digits = trimmed.replace(/\D/g, '')

  if (trimmed.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  }
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
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

export default function Login() {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

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
      setError('Enter a valid phone number, e.g. (555) 123-4567 or +44 7700 900123.')
      return
    }

    setSubmitting(true)
    try {
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
      await confirmOtp(confirmation, code)
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
    'w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-gray-800 focus:outline-none'
  const buttonClass =
    'w-full rounded-lg bg-gray-900 px-4 py-2 font-medium text-white disabled:opacity-50'

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow">
        {!confirmation ? (
          <form onSubmit={handleSendCode} className="space-y-4">
            <h1 className="text-xl font-semibold">Sign in</h1>
            <label className="block space-y-1">
              <span className="text-sm text-gray-600">Phone number</span>
              <input
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(555) 123-4567"
                className={inputClass}
              />
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={submitting || !toE164(phone)}
              className={buttonClass}
            >
              {submitting ? 'Sending…' : 'Send code'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="space-y-4">
            <h1 className="text-xl font-semibold">Enter your code</h1>
            <p className="text-sm text-gray-600">We texted a 6-digit code to {toE164(phone)}.</p>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className={`${inputClass} tracking-widest`}
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button type="submit" disabled={submitting || code.length !== 6} className={buttonClass}>
              {submitting ? 'Verifying…' : 'Verify'}
            </button>
            <button
              type="button"
              onClick={handleChangeNumber}
              disabled={submitting}
              className="w-full text-sm text-gray-600 underline"
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
            className="mt-4 w-full rounded-lg border border-dashed border-gray-400 px-4 py-1.5 text-sm text-gray-600 disabled:opacity-50"
          >
            Dev login
          </button>
        )}
        {/* Mount point for the invisible reCAPTCHA; renders nothing visible. */}
        <div id="recaptcha-container" />
      </div>
    </div>
  )
}
