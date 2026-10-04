import { useEffect, useState } from 'react'
import { FirebaseError } from 'firebase/app'
import { markReviewed, submitReview } from '../../services/zyloveScore'
import { isSeriousReport, submitReport } from '../../services/safety'
import { REVIEW_CATEGORY_DEFS, type ReviewCategoryDef, type ReviewTone } from '../../types/reviewCategories'
import { useModeStore, type Mode } from '../../store/modeStore'

interface ReviewModalProps {
  matchId: string
  // Which match between these two (MatchEntry.startedAt); 0 if unknown.
  generation: number
  partnerUid: string
  name: string
  onClose: () => void
  doneText?: string
  // The connection's mode (Play: red buttons); defaults to the current mode.
  mode?: Mode
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
  { tone: 'negative', title: 'Flag something?', note: 'Counts toward their score once your connection ends. Safety flags reach our team right away.' },
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
  mode,
}: ReviewModalProps) {
  const currentMode = useModeStore((s) => s.mode)
  const accentBg = (mode ?? currentMode) === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
  const [selected, setSelected] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [submitting, onClose])

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((c) => c !== id) : [...s, id]))
  }

  async function submit() {
    if (selected.length === 0 || submitting) return
    setSubmitting(true)
    setError(null)
    // A serious flag is also a report, filed on its own: an earlier review
    // (already-exists) or a failed review never drops it.
    const negatives = selected.filter((id) => REVIEW_CATEGORY_DEFS.find((c) => c.id === id)?.tone === 'negative')
    const report = isSeriousReport(negatives)
      ? submitReport(matchId, generation, partnerUid, negatives).then(() => true, () => false)
      : Promise.resolve(false)
    let reviewed = false
    try {
      await submitReview(matchId, generation, partnerUid, selected)
      reviewed = true
    } catch (err) {
      reviewed = err instanceof FirebaseError && err.code === 'functions/already-exists'
    }
    const reported = await report
    setSubmitting(false)
    if (reviewed || reported) {
      markReviewed(matchId, generation)
      setDone(true)
    } else {
      setError("Couldn't send your review. Try again.")
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
              className={`mt-6 w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 ${accentBg}`}
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
              Your review is anonymous and helps keep Zylove real.
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
              className={`mt-6 w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-30 ${accentBg}`}
            >
              {submitting ? 'Sending…' : 'Submit'}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
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
