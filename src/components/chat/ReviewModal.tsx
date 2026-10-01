import { useEffect, useState } from 'react'
import { FirebaseError } from 'firebase/app'
import { submitReview } from '../../services/zyloveScore'
import {
  FLAG_CATEGORIES,
  NEGATIVE_CATEGORIES,
  POSITIVE_CATEGORIES,
  type ReviewCategory,
  type ReviewCategoryMeta,
} from '../../types/zyloveScore'

interface ReviewModalProps {
  matchId: string
  partnerUid: string
  name: string
  onClose: () => void
}

const TO_FLAG = [...NEGATIVE_CATEGORIES, ...FLAG_CATEGORIES]

// Anonymous post-conversation review feeding the reviewed person's Zylove Score.
export default function ReviewModal({ matchId, partnerUid, name, onClose }: ReviewModalProps) {
  const [selected, setSelected] = useState<ReviewCategory[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function toggle(id: ReviewCategory) {
    setSelected((s) => (s.includes(id) ? s.filter((c) => c !== id) : [...s, id]))
  }

  async function submit() {
    if (selected.length === 0 || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await submitReview(matchId, partnerUid, selected)
      setDone(true)
    } catch (err) {
      if (err instanceof FirebaseError && err.code === 'functions/already-exists') setDone(true)
      else setError("Couldn't send your review. Try again.")
    } finally {
      setSubmitting(false)
    }
  }

  function pill(c: ReviewCategoryMeta) {
    const on = selected.includes(c.id)
    const tint =
      c.sentiment === 'positive'
        ? on
          ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200'
          : 'border-emerald-500/30 bg-emerald-500/5 text-white/70'
        : c.sentiment === 'flag'
          ? on
            ? 'border-red-400 bg-red-500/20 text-red-200'
            : 'border-red-500/30 bg-red-500/5 text-white/70'
          : on
            ? 'border-amber-400 bg-amber-500/20 text-amber-200'
            : 'border-amber-500/30 bg-amber-500/5 text-white/70'
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => toggle(c.id)}
        aria-pressed={on}
        title={c.description}
        className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${tint}`}
      >
        <span aria-hidden>{c.emoji}</span> {c.label}
      </button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-title"
    >
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-6">
        {done ? (
          <div className="py-6 text-center">
            <p id="review-title" className="text-lg font-semibold">
              ✦ Thank you. Your feedback helps Zylove stay real.
            </p>
            <button
              type="button"
              onClick={onClose}
              autoFocus
              className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <h2 id="review-title" className="text-xl font-bold">
              How was your conversation with {name}?
            </h2>
            <p className="mt-1 text-sm text-white/60">
              Your review is anonymous and helps keep Zylove safe and genuine.
            </p>

            <h3 className="mt-6 text-sm font-semibold text-white/80">What went well?</h3>
            <div className="mt-2 flex flex-wrap gap-2">{POSITIVE_CATEGORIES.map(pill)}</div>

            <h3 className="mt-6 text-sm font-semibold text-white/80">Anything to flag?</h3>
            <div className="mt-2 flex flex-wrap gap-2">{TO_FLAG.map(pill)}</div>

            {error && <p className="mt-4 text-center text-sm text-red-400">{error}</p>}
            <button
              type="button"
              onClick={submit}
              disabled={selected.length === 0 || submitting}
              className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              {submitting ? 'Sending…' : 'Submit'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 w-full py-2 text-sm text-white/40 underline hover:text-white/60"
            >
              Not now
            </button>
          </>
        )}
      </div>
    </div>
  )
}
