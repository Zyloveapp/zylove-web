import { useEffect } from 'react'
import { markFirstChatSeen } from './firstChatSeen'

type Mode = 'spark' | 'play'

// Mobile's Spark FirstMessageSafetyCard copy, adjusted for the web: browsers
// can't block screenshots, so that item says so instead.
const FEATURES: { icon: string; title: string; body: string }[] = [
  {
    icon: '✓',
    title: 'Verified profiles',
    body: 'Every member signs up with a verified phone number. This is a real member, not a curated profile.',
  },
  {
    icon: '🔒',
    title: 'End-to-end encrypted',
    body: "Your messages are encrypted on your device, and only you two hold the keys. If you back up your chat key with a chat PIN, that backup is only as strong as the PIN.",
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

// When the partner has no encryption key yet (e.g. an older app version),
// messages in this chat are stored unencrypted — so no E2E promise.
const NOT_ENCRYPTED = (name: string) => ({
  icon: '🔒',
  title: 'Private conversation',
  body: `${name}'s account isn't set up for end-to-end encryption yet, so this chat isn't end-to-end encrypted. Messages still travel over a secure connection.`,
})

// Play keeps the same protections without Vibe Checks (Spark only), and
// ends the report item on Play's privacy promise.
const PLAY_FEATURES = FEATURES.filter((f) => f.title !== 'Vibe Checks keep it real').map((f) =>
  f.title === 'Block or report anytime'
    ? { ...f, body: 'Tap ••• at any point. Reports go to a real person. What happens in Play, stays between you.' }
    : f,
)

const COPY: Record<
  Mode,
  {
    pill: string
    pillClass: string
    title: string
    subtitle: string | null
    features: typeof FEATURES
    iconClass: string
    note: string
    noteClass: string
    button: string
    buttonClass: string
  }
> = {
  spark: {
    pill: '🔵 Zylove · Spark',
    pillClass: 'bg-[#1B4FD8]/15 text-[#7C9BFF]',
    title: "You've got a connection. Here's what's got your back.",
    subtitle: 'Zylove was built so you can focus on the person, not the safety math.',
    features: FEATURES,
    iconClass: 'bg-[#1B4FD8]/15 text-[#7C9BFF]',
    note: "When you're ready to meet in person: public place first, tell a friend where you're going, trust your gut.",
    noteClass: 'border-[#1B4FD8]/25 bg-[#1B4FD8]/10 text-[#B4C6FF]',
    button: "Got it — let's talk",
    buttonClass: 'bg-[#1B4FD8]',
  },
  play: {
    pill: '🔴 Zylove · Play',
    pillClass: 'bg-[#E03131]/15 text-red-300',
    title: "You've got a flame. Here's how Play keeps it between you two.",
    subtitle: null,
    features: PLAY_FEATURES,
    iconClass: 'bg-[#E03131]/15 text-red-300',
    note: "Trust your instincts. Share only what you're comfortable with. Your safety is yours to protect.",
    noteClass: 'border-[#E03131]/25 bg-[#E03131]/10 text-red-200',
    button: "Got it — let's go 🔥",
    buttonClass: 'bg-[#E03131]',
  },
}

interface FirstChatModalProps {
  matchId: string
  // The chat's mode: Play gets its own branding and copy.
  mode: Mode
  name: string
  // Whether messages in this chat are end-to-end encrypted (the partner has
  // a real public key) — the encryption item only promises it when true.
  encrypted: boolean
  onClose: () => void
}

// Shown once per match (mobile's equivalent is FirstMessageSafetyCard).
// Bottom sheet on mobile, centered card on desktop.
export default function FirstChatModal({ matchId, mode, name, encrypted, onClose }: FirstChatModalProps) {
  const copy = COPY[mode]
  const features = encrypted ? copy.features : copy.features.map((f) => (f.title === 'End-to-end encrypted' ? NOT_ENCRYPTED(name) : f))
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
        <span className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${copy.pillClass}`}>{copy.pill}</span>
        <h2 id="first-chat-title" className="mt-3 text-xl font-bold">
          {copy.title}
        </h2>
        {copy.subtitle && <p className="mt-1 text-sm text-white/60">{copy.subtitle}</p>}

        <ul className="mt-5 divide-y divide-white/10">
          {features.map((f) => (
            <li key={f.title} className="flex gap-3 py-3 first:pt-0">
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${copy.iconClass}`}>
                {f.icon}
              </span>
              <div>
                <p className="text-sm font-semibold">{f.title}</p>
                <p className="text-sm leading-snug text-white/60">{f.body}</p>
              </div>
            </li>
          ))}
        </ul>

        <p className={`mt-4 rounded-xl border px-4 py-3 text-sm leading-snug ${copy.noteClass}`}>💡 {copy.note}</p>

        <button
          type="button"
          onClick={dismiss}
          autoFocus
          className={`mt-6 w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 ${copy.buttonClass}`}
        >
          {copy.button}
        </button>
        <p className="mt-3 text-center text-xs text-white/40">
          This message appears once. Tap ••• in the chat header to access safety features anytime.
        </p>
      </div>
    </div>
  )
}
