import { useEffect } from 'react'
import { markFirstChatSeen } from './firstChatSeen'

const FEATURES: { icon: string; title: string; body: string }[] = [
  {
    icon: '🔒',
    title: 'Privacy first',
    body: 'What’s said here stays here. Zylove staff cannot read your conversations.',
  },
  {
    icon: '✦',
    title: 'Intentional connections',
    body: 'You both chose this. Take your time, be yourself.',
  },
  {
    icon: '🚩',
    title: 'Report & block',
    body: 'Something feel off? Use the report button anytime. We take it seriously.',
  },
]

interface FirstChatModalProps {
  matchId: string
  name: string
  onClose: () => void
}

// Shown once per match on web (mobile's equivalent is FirstMessageSafetyCard).
// Bottom sheet on mobile, centered card on desktop.
export default function FirstChatModal({ matchId, name, onClose }: FirstChatModalProps) {
  function dismiss() {
    markFirstChatSeen(matchId)
    onClose()
  }

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return
      markFirstChatSeen(matchId)
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [matchId, onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-chat-title"
    >
      <div className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
        <h2 id="first-chat-title" className="text-xl font-bold">
          ✦ You matched with {name}
        </h2>
        <p className="mt-1 text-sm text-white/60">Here’s how Zylove keeps this space safe and real.</p>

        <ul className="mt-5 space-y-4">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1B4FD8]/15 text-[#7C9BFF]">
                {f.icon}
              </span>
              <div>
                <p className="text-sm font-semibold">{f.title}</p>
                <p className="text-sm leading-snug text-white/60">{f.body}</p>
              </div>
            </li>
          ))}
        </ul>

        <p className="mt-5 text-center text-xs text-white/40">Message encryption coming soon.</p>

        <button
          type="button"
          onClick={dismiss}
          autoFocus
          className="mt-4 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90"
        >
          Start the conversation
        </button>
      </div>
    </div>
  )
}
