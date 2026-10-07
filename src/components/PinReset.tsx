import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ConfirmationResult, RecaptchaVerifier } from 'firebase/auth'
import { PinScreen } from './PinPad'
import { accountPhone, maskPhone, sendResetCode } from '../services/playPin'

interface PinResetProps {
  uid: string
  onVerified: () => void
  onCancel: () => void
}

// "Forgot your PIN?" — texts a code to the account's own phone number; a
// verified code lets a new PIN replace the old one (the server accepts a
// reset for a few minutes after the re-verification).
export default function PinReset({ onVerified, onCancel }: PinResetProps) {
  const phone = accountPhone()
  const captcha = useRef<HTMLDivElement>(null)
  const verifier = useRef<RecaptchaVerifier | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => verifier.current?.clear(), [])

  async function send() {
    if (!captcha.current || busy) return
    setBusy(true)
    setError(null)
    try {
      verifier.current?.clear()
      // reCAPTCHA won't render twice into one element, so use a fresh child.
      const el = document.createElement('div')
      captcha.current.replaceChildren(el)
      const sent = sendResetCode(el)
      verifier.current = sent.verifier
      setConfirmation(await sent.result)
    } catch {
      setError("Couldn't send a code. Try again in a moment.")
    } finally {
      setBusy(false)
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault()
    if (!confirmation || code.length < 6 || busy) return
    setBusy(true)
    setError(null)
    try {
      await confirmation.confirm(code)
      onVerified()
    } catch {
      setError("That code didn't work. Check it and try again.")
      setBusy(false)
    }
  }

  return (
    <PinScreen
      title="Reset your Play PIN"
      subtitle={
        !phone
          ? "There's no phone number on this account, so the PIN can't be reset by text."
          : confirmation
            ? `Enter the 6-digit code sent to ${maskPhone(phone)}.`
            : `We'll text a code to ${maskPhone(phone)}.`
      }
    >
      <div className="flex w-72 flex-col items-center gap-4">
        {phone && !confirmation && (
          <button
            type="button"
            onClick={send}
            disabled={busy}
            className="w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send code'}
          </button>
        )}
        {confirmation && (
          <form onSubmit={verify} className="flex w-full flex-col gap-3">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="••••••"
              aria-label="Verification code"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-2xl tracking-[0.4em] text-white placeholder:text-white/20 focus:border-white/30 focus:outline-none"
            />
            <button
              type="submit"
              disabled={code.length < 6 || busy}
              className="w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? 'Checking…' : 'Verify'}
            </button>
          </form>
        )}
        {error && (
          <p className="text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
        <button type="button" onClick={onCancel} className="text-sm text-white/50 hover:text-white">
          Cancel
        </button>
      </div>
      <div ref={captcha} />
    </PinScreen>
  )
}
