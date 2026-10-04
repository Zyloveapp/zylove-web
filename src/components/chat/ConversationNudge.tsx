import { useEffect, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../../services/firebase'
import SparkleIcon from '../icons/SparkleIcon'

export interface NudgeMessage {
  senderId: string
  text: string
  sentAt: number | null
}

const QUIET_AFTER_MS = 2 * 60 * 60 * 1000

// Mobile's isConversationStalling: short replies, a monologue, or a young
// conversation gone quiet.
function isStalling(messages: NudgeMessage[], now: number): boolean {
  if (messages.length < 4) return false
  const recent = messages.slice(-4)
  if (recent.reduce((sum, m) => sum + m.text.length, 0) / recent.length < 10) return true
  if (new Set(recent.map((m) => m.senderId)).size === 1) return true
  const last = recent[recent.length - 1].sentAt
  return last !== null && now - last > QUIET_AFTER_MS && messages.length < 20
}

interface ConversationNudgeProps {
  matchId: string
  partnerUid: string
  mode: 'spark' | 'play'
  messages: NudgeMessage[]
  // Suppressed while another chat modal is up.
  suppressed: boolean
  // Fills the message input; never sends.
  onPick: (text: string) => void
}

type Sheet = { starters: string[] | null }

// "✦ Need a spark?" (Play: "Need inspiration? 🔥") banner above the chat input when a conversation stalls.
export default function ConversationNudge({ matchId, partnerUid, mode, messages, suppressed, onPick }: ConversationNudgeProps) {
  const play = mode === 'play'
  const [now, setNow] = useState(() => Date.now())
  const [sheet, setSheet] = useState<Sheet | null>(null)
  // Message count when the user said "I'm good"; the banner returns once the chat moves on.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)

  // Re-evaluates the "gone quiet" rule while the chat sits open.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!sheet) return
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setSheet(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheet])

  async function open() {
    setSheet({ starters: null })
    const { data } = await httpsCallable<{ matchId: string; otherUid: string }, { starters: string[] }>(
      functions,
      'generateConversationStarter',
    )({ matchId, otherUid: partnerUid }).catch(() => ({ data: { starters: [] as string[] } }))
    setSheet((s) => (s ? { starters: data.starters } : s))
  }

  function dismiss() {
    setSheet(null)
    setDismissedAt(messages.length)
  }

  const visible = !suppressed && dismissedAt !== messages.length && isStalling(messages, now)

  return (
    <>
      {visible && (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            onClick={open}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
              play
                ? 'border-[#E03131]/40 bg-[#E03131]/10 text-red-300 hover:bg-[#E03131]/20'
                : 'border-[#1B4FD8]/40 bg-[#1B4FD8]/10 text-[#7C9BFF] hover:bg-[#1B4FD8]/20'
            }`}
          >
            {play ? (
              'Need inspiration? 🔥'
            ) : (
              <>
                <SparkleIcon className="h-3.5 w-3.5" />
                Need a spark?
              </>
            )}
          </button>
        </div>
      )}

      {sheet && (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nudge-title"
          onClick={(e) => e.target === e.currentTarget && setSheet(null)}
        >
          <div className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
            <h2 id="nudge-title" className="flex items-center justify-center gap-2 text-xl font-bold">
              {play ? (
                'Need inspiration? 🔥'
              ) : (
                <>
                  <span className="text-[#7C9BFF]" aria-hidden>
                    ✦
                  </span>
                  Need a spark?
                </>
              )}
            </h2>
            <div className="mt-5 space-y-2">
              {sheet.starters === null ? (
                <div className="flex justify-center py-6">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                </div>
              ) : sheet.starters.length === 0 ? (
                <p className="py-4 text-center text-sm text-white/50">Couldn't find ideas right now. Try again soon.</p>
              ) : (
                sheet.starters.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      onPick(s)
                      setSheet(null)
                    }}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left text-sm leading-snug text-white/90 hover:bg-white/10"
                  >
                    {s}
                  </button>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={dismiss}
              className="mt-4 w-full py-2 text-sm text-white/40 underline hover:text-white/60"
            >
              I'm good
            </button>
          </div>
        </div>
      )}
    </>
  )
}
