import { useEffect } from 'react'
import { markFirstChatSeen } from './firstChatSeen'

// Mobile's Spark FirstMessageSafetyCard copy, adjusted for the web: browsers
// can't block screenshots, so that item says so instead.
const FEATURES: { icon: string; title: string; body: string }[] = [
  {
    icon: '✓',
    title: 'Verified profiles',
    body: "Every person here passed phone verification. You're talking to a real human.",
  },
  {
    icon: '🔒',
    title: 'End-to-end encrypted',
    body: 'Your messages are encrypted on your device. Only you two can read them. Not even us.',
  },
  {
    icon: '📸',
    title: 'Photo sharing requires consent',
    body: 'Neither of you can send photos until you both agree. Photos are end-to-end encrypted.',
  },
  {
    icon: '⚠',
    title: 'Screenshots',
    body: "Web browsers can't block screenshots — only share what you're comfortable with.",
  },
  {
    icon: '✦',
    title: 'Vibe Checks keep it real',
    body: "As the conversation flows, you'll get a private check-in — just for you. Rate the vibe, unlock conversation sparks, and when you're both feeling it, you'll know.",
  },
  {
    icon: '🚨',
    title: 'Block or report anytime',
    body: 'Tap ••• at any point. Reports go to a real person. Serious safety issues are escalated immediately.',
  },
]

const SAFETY_NOTE =
  "When you're ready to meet in person: public place first, tell a friend where you're going, trust your gut."

interface FirstChatModalProps {
  matchId: string
  onClose: () => void
}

// Shown once per match (mobile's equivalent is FirstMessageSafetyCard).
// Bottom sheet on mobile, centered card on desktop.
export default function FirstChatModal({ matchId, onClose }: FirstChatModalProps) {
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
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-6">
        <span className="inline-block rounded-full bg-[#1B4FD8]/15 px-3 py-1 text-xs font-semibold text-[#7C9BFF]">
          🔵 Zylove · Spark
        </span>
        <h2 id="first-chat-title" className="mt-3 text-xl font-bold">
          You've got a connection. Here's what's got your back.
        </h2>
        <p className="mt-1 text-sm text-white/60">
          Zylove was built so you can focus on the person, not the safety math.
        </p>

        <ul className="mt-5 divide-y divide-white/10">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex gap-3 py-3 first:pt-0">
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

        <p className="mt-4 rounded-xl border border-[#1B4FD8]/25 bg-[#1B4FD8]/10 px-4 py-3 text-sm leading-snug text-[#B4C6FF]">
          💡 {SAFETY_NOTE}
        </p>

        <button
          type="button"
          onClick={dismiss}
          autoFocus
          className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90"
        >
          Got it — let's talk
        </button>
        <p className="mt-3 text-center text-xs text-white/40">
          This message appears once. Tap ••• in the chat header to access safety features anytime.
        </p>
      </div>
    </div>
  )
}
