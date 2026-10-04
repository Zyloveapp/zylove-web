import { useCallback, useEffect, useState } from 'react'
import { FirebaseError } from 'firebase/app'
import ScoreRing from '../ScoreRing'
import { fetchProfileReview, type ProfileScorecard } from '../../services/profile'

type Mode = 'spark' | 'play'
type State =
  | { status: 'loading' }
  | { status: 'done'; review: ProfileScorecard }
  | { status: 'error'; message: string; limited: boolean }

const THEME = {
  spark: {
    accent: '#1B4FD8',
    accentText: 'text-[#7C9BFF]',
    ring: '#6B8FFF',
    panel: 'border-[#1B4FD8]/30 bg-[#070b17]',
    divider: 'border-[#1B4FD8]/20',
    card: 'border-[#1B4FD8]/20 bg-[#1B4FD8]/[0.06]',
    title: 'Your Spark profile score',
    regenerate: 'Regenerate',
  },
  play: {
    accent: '#E03131',
    accentText: 'text-red-400',
    ring: null,
    panel: 'border-[#E03131]/30 bg-[#140707]',
    divider: 'border-[#E03131]/20',
    card: 'border-[#E03131]/20 bg-[#E03131]/[0.06]',
    title: 'Your Play profile score',
    regenerate: 'Regenerate (uses one of 3 weekly reviews)',
  },
} as const

// Red under 60, amber 60–79, green 80+.
function scoreColor(score: number): string {
  return score < 60 ? '#E03131' : score < 80 ? '#F59E0B' : '#22C55E'
}

function errorState(err: unknown): State {
  const code = err instanceof FirebaseError ? err.code : ''
  if (code === 'functions/resource-exhausted') {
    return { status: 'error', limited: true, message: "You've used this week's 3 Play profile reviews. Try again next week." }
  }
  if (code === 'functions/failed-precondition') {
    return { status: 'error', limited: true, message: 'Set up your Play profile first.' }
  }
  return { status: 'error', limited: false, message: "Couldn't generate review. Try again." }
}

// "How's my profile?" for either mode: an AI scorecard — overall ring, four
// scored sections with what's working and what to improve, and the one top
// suggestion. Spark is cobalt, Play is red; Play reviews are 3 per week.
export default function ProfileReviewSheet({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const theme = THEME[mode]
  const [state, setState] = useState<State>({ status: 'loading' })

  const fetchReview = useCallback(() => {
    fetchProfileReview(mode)
      .then((review) => setState({ status: 'done', review }))
      .catch((err: unknown) => setState(errorState(err)))
  }, [mode])

  useEffect(() => {
    fetchReview()
  }, [fetchReview])

  function regenerate() {
    setState({ status: 'loading' })
    fetchReview()
  }

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-review-title"
    >
      <div className={`flex max-h-[90dvh] w-full flex-col rounded-t-2xl border text-white lg:max-w-lg lg:rounded-2xl ${theme.panel}`}>
        {/* Scrolls under a fixed footer; the bottom padding lets the last card clear it. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-8">
          {state.status === 'loading' ? (
            <div className="flex flex-col items-center gap-3 py-16 text-sm text-white/50">
              <span
                className="h-7 w-7 animate-spin rounded-full border-2 border-white/20"
                style={{ borderTopColor: theme.accent }}
              />
              Reading your profile…
            </div>
          ) : state.status === 'error' ? (
            <p className="py-16 text-center text-sm text-white/70">{state.message}</p>
          ) : (
            <Scorecard review={state.review} mode={mode} />
          )}
        </div>

        <div className={`shrink-0 border-t px-6 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] ${theme.divider}`}>
          {!(state.status === 'error' && state.limited) && (
            <button
              type="button"
              onClick={regenerate}
              disabled={state.status === 'loading'}
              className="mb-2 w-full py-2 text-sm text-white/50 hover:text-white disabled:opacity-40"
            >
              {theme.regenerate}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: theme.accent }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full" style={{ width: `${score}%`, backgroundColor: scoreColor(score) }} />
    </div>
  )
}

function Scorecard({ review, mode }: { review: ProfileScorecard; mode: Mode }) {
  const theme = THEME[mode]
  return (
    <>
      <div className="flex flex-col items-center text-center">
        <ScoreRing
          score={review.overallScore}
          color={theme.ring ?? scoreColor(review.overallScore)}
          trackClassName="text-white/20"
          numberClassName="text-white"
        />
        <h2 id="profile-review-title" className="mt-3 text-lg font-bold">
          {theme.title}
        </h2>
      </div>

      <div className="mt-6 space-y-3">
        {review.sections.map((s) => (
          <section key={s.name} className={`rounded-2xl border p-4 ${theme.card}`}>
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-semibold">
                {s.name} · <span style={{ color: scoreColor(s.score) }}>{s.score}</span>
              </h3>
            </div>
            <ScoreBar score={s.score} />
            <p className="mt-3 text-sm leading-snug text-green-400">✓ {s.working}</p>
            <p className="mt-2 text-sm leading-snug text-amber-400">↑ {s.improve}</p>
          </section>
        ))}
      </div>

      {review.photos && (
        <section className={`mt-3 rounded-2xl border p-4 ${theme.card}`}>
          <h3 className="font-semibold">
            Photos · <span style={{ color: scoreColor(review.photos.score) }}>{review.photos.score}</span>
          </h3>
          <ScoreBar score={review.photos.score} />
          <p className="mt-3 text-sm leading-snug text-green-400">✓ {review.photos.working}</p>
          <p className="mt-2 text-sm leading-snug text-amber-400">↑ {review.photos.improve}</p>
          {review.photos.suggestions.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-snug text-white/75">
              {review.photos.suggestions.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className={`mt-5 rounded-2xl border p-4 ${theme.card}`}>
        <h3 className={`text-xs font-semibold uppercase tracking-widest ${theme.accentText}`}>💡 Top suggestion</h3>
        <p className="mt-2 text-lg leading-snug text-white">{review.topSuggestion}</p>
      </section>
    </>
  )
}
