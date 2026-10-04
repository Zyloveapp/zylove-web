import { useCallback, useEffect, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from '../../services/firebase'

type State = { status: 'loading' } | { status: 'done'; review: string } | { status: 'error'; message: string }

// "How's my Play profile? 🔥" — an AI review of the saved Play profile.
// Every review (including Regenerate) counts toward 3 per week.
export default function PlayReviewModal({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  const run = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const { data } = await httpsCallable<void, { review: string }>(functions, 'reviewPlayProfile', { timeout: 120_000 })()
      setState({ status: 'done', review: data.review })
    } catch (err) {
      const code = err instanceof FirebaseError ? err.code : ''
      setState({
        status: 'error',
        message:
          code === 'functions/resource-exhausted'
            ? "You've used this week's 3 Play profile reviews. Try again next week."
            : code === 'functions/failed-precondition'
              ? 'Set up your Play profile first.'
              : "Couldn't review your profile right now. Try again in a moment.",
      })
    }
  }, [])

  useEffect(() => {
    void run()
  }, [run])

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
      aria-labelledby="play-review-title"
    >
      <div className="flex max-h-[90dvh] w-full flex-col rounded-t-2xl border border-[#E03131]/30 bg-[#140707] text-white lg:max-w-lg lg:rounded-2xl">
        <h2 id="play-review-title" className="border-b border-[#E03131]/20 px-6 py-4 text-lg font-bold">
          Your Play profile review 🔥
        </h2>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {state.status === 'loading' ? (
            <div className="flex flex-col items-center gap-3 py-10 text-sm text-white/50">
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-[#E03131]" />
              Reading your profile…
            </div>
          ) : state.status === 'error' ? (
            <p className="py-6 text-center text-sm text-red-300">{state.message}</p>
          ) : (
            <p className="whitespace-pre-line text-sm leading-relaxed text-white/85">{state.review}</p>
          )}
        </div>
        <div className="border-t border-[#E03131]/20 px-6 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="w-full rounded-xl bg-[#E03131] py-3 font-semibold text-white transition-opacity hover:opacity-90"
          >
            Got it
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={state.status === 'loading'}
            className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white disabled:opacity-40"
          >
            Regenerate (uses one of 3 weekly reviews)
          </button>
        </div>
      </div>
    </div>
  )
}
