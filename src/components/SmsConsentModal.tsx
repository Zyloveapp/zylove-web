import { useEffect } from 'react'

// First-time SMS opt-in (Settings, and onboarding before the founder
// invitation). The caller records consent with grantSmsConsent.
export default function SmsConsentModal({ onAccept, onDecline, busy }: { onAccept: () => void; onDecline: () => void; busy: boolean }) {
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
          Get Zylove updates by text
        </h2>
        <p className="mt-2 text-sm text-white/60">
          Turn on texts to be notified when founder spots open, get match alerts and never miss a message. We'll text you
          when something important happens — a new Spark, a message, a match. Standard rates apply. You can turn this off
          anytime.
        </p>
        {/* Carrier (A2P) consent wording: frequency + how to opt out. */}
        <p className="mt-2 text-xs text-white/40">Message frequency varies. Reply STOP to opt out, HELP for help.</p>
        <button
          type="button"
          onClick={onAccept}
          disabled={busy}
          autoFocus
          className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Turning on…' : 'Turn on'}
        </button>
        <button
          type="button"
          onClick={onDecline}
          disabled={busy}
          className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white"
        >
          Not now
        </button>
      </div>
    </div>
  )
}
