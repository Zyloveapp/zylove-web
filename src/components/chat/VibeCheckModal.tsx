import { useEffect, useState } from 'react'
import { loadOpeners, markVibeCheckRated, recordVibeRating, type VibeRating } from '../../services/vibeCheck'

interface VibeCheckModalProps {
  matchId: string
  partnerUid: string
  name: string
  onClose: () => void
  // Tapping an opener drops it into the message input (never auto-sends).
  onUseOpener: (text: string) => void
  // Play's accent is red, Spark's cobalt.
  mode: 'spark' | 'play'
}

type Phase = 'prompt' | 'loving_it' | 'alright' | 'meh'

const REDIRECT_COPY = {
  alright: {
    title: 'Need some inspiration?',
    sub: 'Here are a few directions worth trying.',
    dismiss: "I'm good, thanks",
  },
  meh: {
    title: 'Want to try a different direction?',
    sub: 'Sometimes conversations need a reset.',
    dismiss: "I'll figure it out",
  },
} as const

// Web version of mobile's VibeCheckPrompt. Same bottom-sheet shell as
// FirstChatModal, sliding up on open. Copy matches mobile exactly.
export default function VibeCheckModal({ matchId, partnerUid, name, onClose, onUseOpener, mode }: VibeCheckModalProps) {
  const accentBg = mode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
  const accentText = mode === 'play' ? 'text-[#E03131]' : 'text-[#1B4FD8]'
  const [phase, setPhase] = useState<Phase>('prompt')
  const [openers, setOpeners] = useState<string[] | null>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function rate(rating: VibeRating) {
    // Recorded silently; a failure (e.g. server cooldown) shouldn't interrupt the chat.
    markVibeCheckRated(matchId)
    recordVibeRating(matchId, partnerUid, rating).catch(() => {})
    setPhase(rating)
    if (rating !== 'loving_it') loadOpeners(partnerUid, mode).then(setOpeners)
  }

  const optionBase = 'flex w-full items-center justify-center gap-2 rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vibe-check-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] transition-transform duration-300 ease-out lg:max-w-sm lg:rounded-2xl lg:pb-6 ${
          shown ? 'translate-y-0' : 'translate-y-full lg:translate-y-8'
        }`}
      >
        {phase === 'prompt' && (
          <>
            <h2 id="vibe-check-title" className="text-center text-xl font-bold">
              How's this going?
            </h2>
            <p className="mt-1 text-center text-sm text-white/60">Just between us.</p>
            <div className="mt-6 space-y-2">
              <button type="button" onClick={() => rate('loving_it')} className={`${optionBase} ${accentBg}`}>
                <span aria-hidden>🔥</span> Loving it
              </button>
              <button type="button" onClick={() => rate('alright')} className={`${optionBase} bg-white/10`}>
                <span aria-hidden>😊</span> It's alright
              </button>
              <button type="button" onClick={() => rate('meh')} className={`${optionBase} bg-white/10`}>
                <span aria-hidden>😐</span> Meh
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 w-full py-2 text-sm text-white/40 underline hover:text-white/60"
            >
              Not now
            </button>
          </>
        )}

        {phase === 'loving_it' && (
          <>
            <p className={`text-center text-5xl ${accentText}`} aria-hidden>
              {mode === 'play' ? '🔥' : '✦'}
            </p>
            <h2 id="vibe-check-title" className="mt-2 text-center text-xl font-bold">
              Keep it going.
            </h2>
            <p className="mt-1 text-center text-sm text-white/60">
              {name} doesn't know you rated — but the vibes are speaking for themselves.
            </p>
            <button type="button" onClick={onClose} autoFocus className={`${optionBase} mt-6 ${accentBg}`}>
              Back to the conversation
            </button>
          </>
        )}

        {(phase === 'alright' || phase === 'meh') && (
          <>
            <h2 id="vibe-check-title" className="text-center text-xl font-bold">
              {REDIRECT_COPY[phase].title}
            </h2>
            <p className="mt-1 text-center text-sm text-white/60">{REDIRECT_COPY[phase].sub}</p>
            <div className="mt-6 space-y-2">
              {openers === null ? (
                <div className="flex justify-center py-6">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                </div>
              ) : (
                openers.map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => {
                      onUseOpener(o)
                      onClose()
                    }}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left text-sm leading-snug text-white/90 hover:bg-white/10"
                  >
                    {o}
                  </button>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 w-full py-2 text-sm text-white/40 underline hover:text-white/60"
            >
              {REDIRECT_COPY[phase].dismiss}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
