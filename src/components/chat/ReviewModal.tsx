import { useEffect, useState } from 'react'
import { FirebaseError } from 'firebase/app'
import { markReviewed, submitReview } from '../../services/zyloveScore'
import { isSeriousReport, reportAndBan } from '../../services/safety'
import { REVIEW_CATEGORY_DEFS, type ReviewCategoryDef, type ReviewTone } from '../../types/reviewCategories'

interface ReviewModalProps {
  matchId: string
  // Which match between these two (MatchEntry.startedAt); 0 if unknown.
  generation: number
  partnerUid: string
  name: string
  onClose: () => void
  doneText?: string
}

const PILL_TINT: Record<ReviewTone, { on: string; off: string }> = {
  positive: {
    on: 'border-emerald-400 bg-emerald-500/20 text-emerald-200',
    off: 'border-emerald-500/30 bg-emerald-500/5 text-white/70',
  },
  neutral: {
    on: 'border-white/50 bg-white/15 text-white',
    off: 'border-white/15 bg-white/5 text-white/60',
  },
  negative: {
    on: 'border-amber-400 bg-red-500/20 text-amber-200',
    off: 'border-amber-500/30 bg-red-500/5 text-white/70',
  },
}

const SECTIONS: { tone: ReviewTone; title: string; note?: string }[] = [
  { tone: 'positive', title: 'What went well?' },
  { tone: 'neutral', title: 'Anything to note?' },
  { tone: 'negative', title: 'Flag something?', note: 'Negative feedback is processed privately after your connection ends.' },
]

// Anonymous review of a connection, feeding the reviewed person's Zylove
// Score. Only offered once a match has ended or gone cold, never mid-chat.
export default function ReviewModal({
  matchId,
  generation,
  partnerUid,
  name,
  onClose,
  doneText = '✦ Thank you. Your honesty helps Zylove stay real.',
}: ReviewModalProps) {
  const [selected, setSelected] = useState<string[]>([])
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

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((c) => c !== id) : [...s, id]))
  }

  async function submit() {
    if (selected.length === 0 || submitting) return
    setSubmitting(true)
    setError(null)
    // Serious reports also flag the phone number. Best effort: a failure
    // there never loses the review itself.
    const flagPhone = () =>
      isSeriousReport(selected) ? reportAndBan(partnerUid, matchId, selected).catch(() => {}) : Promise.resolve()
    try {
      await submitReview(matchId, generation, partnerUid, selected)
      await flagPhone()
      markReviewed(matchId, generation)
      setDone(true)
    } catch (err) {
      if (err instanceof FirebaseError && err.code === 'functions/already-exists') {
        await flagPhone()
        markReviewed(matchId, generation)
        setDone(true)
      } else {
        setError("Couldn't send your review. Try again.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  function pill(c: ReviewCategoryDef) {
    const on = selected.includes(c.id)
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => toggle(c.id)}
        aria-pressed={on}
        className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${PILL_TINT[c.tone][on ? 'on' : 'off']}`}
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
              {doneText}
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
              How was your time with {name}?
            </h2>
            <p className="mt-1 text-sm text-white/60">
              Your review is anonymous and helps keep Zylove real. It's processed after your connection ends.
            </p>

            {SECTIONS.map((section) => (
              <section key={section.tone} className="mt-6">
                <h3 className="text-sm font-semibold text-white/80">{section.title}</h3>
                {section.note && <p className="mt-0.5 text-xs text-white/40">{section.note}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {REVIEW_CATEGORY_DEFS.filter((c) => c.tone === section.tone).map(pill)}
                </div>
              </section>
            ))}

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
