import { useEffect } from 'react'
import { createPortal } from 'react-dom'

// What a founder gets, and what's asked in return. Shared by the invitation
// (onboarding, profile) and /claim-founder.
export function FounderBenefits({ cityName }: { cityName: string }) {
  return (
    <div className="space-y-4 text-left text-white/70">
      <p>We're building something real here and we want you to be part of it.</p>
      <div>
        <p className="font-semibold text-white">Founding members get:</p>
        <ul className="mt-2 space-y-1.5">
          {[
            'Elite access — forever, free',
            `A permanent ${cityName} Founder badge`,
            'Direct line to the founder',
            'First in the queue when we go live',
          ].map((b) => (
            <li key={b} className="flex gap-2">
              <span className="text-[#6B8FFF]" aria-hidden>
                ·
              </span>
              {b}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-sm text-white/50">
        In return — show up. Be part of the community while we grow. Founders who go inactive during launch may lose their
        spot to someone who wants it.
      </p>
    </div>
  )
}

export default function FounderInviteModal({
  cityName,
  busy,
  error,
  onAccept,
  onLater,
}: {
  cityName: string
  busy: boolean
  error: string | null
  onAccept: () => void
  onLater: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onLater()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onLater])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="founder-invite-title"
      className="fixed inset-0 z-[80] flex items-end justify-center overflow-y-auto bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
    >
      <div className="w-full rounded-t-2xl border border-[#1B4FD8]/30 bg-gray-950 px-6 pt-7 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-7">
        <h2 id="founder-invite-title" className="text-2xl font-bold leading-tight">
          <span className="text-[#6B8FFF]">✦</span> You're one of the first in {cityName}.
        </h2>
        <div className="mt-5">
          <FounderBenefits cityName={cityName} />
        </div>
        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
        <button
          type="button"
          onClick={onAccept}
          disabled={busy}
          autoFocus
          className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3.5 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Saving your spot…' : "✦ I'm in — make me a founder"}
        </button>
        <button
          type="button"
          onClick={onLater}
          disabled={busy}
          className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white disabled:opacity-50"
        >
          Maybe later — I'll decide from my profile
        </button>
      </div>
    </div>,
    document.body,
  )
}
