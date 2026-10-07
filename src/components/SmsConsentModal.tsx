import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { SMS_CONSENT_TEXT } from '../config/smsConsent'

// "See SMS Terms." ends the consent wording; it's rendered as a link.
const SEE_TERMS = 'See SMS Terms.'
const CONSENT_LEAD = SMS_CONSENT_TEXT.endsWith(SEE_TERMS) ? SMS_CONSENT_TEXT.slice(0, -SEE_TERMS.length).trimEnd() : SMS_CONSENT_TEXT

// SMS opt-in (Settings, and onboarding before the founder invitation): an
// unchecked box with the carrier (A2P) wording; Turn on stays disabled until
// it's ticked. The caller records consent with grantSmsConsent, which stores
// SMS_CONSENT_VERSION with it.
export default function SmsConsentModal({ onAccept, onDecline, busy }: { onAccept: () => void; onDecline: () => void; busy: boolean }) {
  const [agreed, setAgreed] = useState(false)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onDecline()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDecline])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sms-consent-title"
    >
      <div className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
        <h2 id="sms-consent-title" className="text-xl font-bold">
          Text notifications
        </h2>
        <p className="mt-2 text-sm text-white/60">
          Get a text when you have a new match or message, plus important alerts about your account. Optional — Zylove
          works without them, and you can turn them off anytime in Settings.
        </p>
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-3">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            disabled={busy}
            className="mt-0.5 h-5 w-5 shrink-0 accent-[#1B4FD8]"
          />
          <span className="text-sm text-white/80">
            {CONSENT_LEAD}{' '}
            <Link to="/sms-terms" target="_blank" rel="noreferrer" className="text-[#7C9BFF] underline hover:text-white">
              See SMS Terms.
            </Link>
          </span>
        </label>
        <button
          type="button"
          onClick={onAccept}
          disabled={busy || !agreed}
          className="mt-5 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Turning on…' : 'Turn on'}
        </button>
        <button
          type="button"
          onClick={onDecline}
          disabled={busy}
          autoFocus
          className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white"
        >
          Not now
        </button>
      </div>
    </div>
  )
}
