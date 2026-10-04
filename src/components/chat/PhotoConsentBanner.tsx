import { useEffect } from 'react'
import { useModeStore } from '../../store/modeStore'

const POINTS: { icon: string; text: string; warn?: boolean }[] = [
  { icon: '✓', text: 'Both people must agree before photos can be shared' },
  { icon: '✓', text: 'Photos are end-to-end encrypted — only you two can see them' },
  { icon: '✓', text: 'Set a timer and photos delete automatically after viewing' },
  { icon: '⚠', text: "Web browsers can't block screenshots — only share what you're comfortable with", warn: true },
  { icon: '✓', text: 'Either person can pause sharing anytime' },
]

interface PhotoConsentBannerProps {
  onProceed: () => void
  onCancel: () => void
}

// Shown the first time someone asks to share photos in a chat
// (zylove_photo_consent_seen_{matchId}).
export default function PhotoConsentBanner({ onProceed, onCancel }: PhotoConsentBannerProps) {
  // Play: red checkmarks and button; Spark keeps green and cobalt.
  const play = useModeStore((s) => s.mode) === 'play'
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="photo-consent-title"
    >
      <div className="flex h-[100dvh] w-full flex-col overflow-y-auto bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:h-auto lg:max-w-md lg:rounded-2xl lg:pb-6">
        <button type="button" onClick={onCancel} className="self-start text-sm text-white/50 hover:text-white">
          Cancel
        </button>
        <h2 id="photo-consent-title" className="mt-6 text-2xl font-bold">
          How photo sharing works
        </h2>
        <ul className="mt-6 space-y-4">
          {POINTS.map((p) => (
            <li key={p.text} className="flex gap-3">
              <span className={`mt-0.5 shrink-0 font-bold ${p.warn ? 'text-amber-300' : play ? 'text-[#E03131]' : 'text-emerald-300'}`} aria-hidden>
                {p.icon}
              </span>
              <span className={p.warn ? 'text-amber-100/90' : 'text-white/80'}>{p.text}</span>
            </li>
          ))}
        </ul>
        <div className="mt-auto pt-8 lg:mt-8 lg:pt-0">
          <button
            type="button"
            onClick={onProceed}
            autoFocus
            className={`w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 ${
              play ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
            }`}
          >
            Got it — send a request
          </button>
          <p className="mt-3 text-center text-xs text-white/40">This appears once per conversation.</p>
        </div>
      </div>
    </div>
  )
}
