import { useEffect, useState } from 'react'
import { fetchProfileReview, type ProfileReview } from '../../services/profile'

// "✦ How's my profile?" — AI feedback on the user's own profile.
export default function ProfileReviewModal({ onClose }: { onClose: () => void }) {
  const [review, setReview] = useState<ProfileReview | null | 'error'>(null)

  useEffect(() => {
    let cancelled = false
    fetchProfileReview()
      .then((r) => !cancelled && setReview(r))
      .catch(() => !cancelled && setReview('error'))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-review-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-6">
        <h2 id="profile-review-title" className="text-xl font-bold">
          ✦ How's my profile?
        </h2>

        {review === null ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-[#7C9BFF]" />
            <p className="text-sm text-white/60">Analyzing your profile...</p>
          </div>
        ) : review === 'error' ? (
          <p className="py-10 text-center text-sm text-white/60">Couldn't review your profile right now. Try again soon.</p>
        ) : (
          <div className="mt-5 space-y-6">
            <section>
              <h3 className="text-sm font-semibold text-emerald-300">What's working ✓</h3>
              <ul className="mt-2 space-y-2">
                {review.strengths.map((s) => (
                  <li key={s} className="text-sm leading-snug text-white/80">
                    {s}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="text-sm font-semibold text-amber-300">Room to grow →</h3>
              <ul className="mt-2 space-y-2">
                {review.improvements.map((s) => (
                  <li key={s} className="text-sm leading-snug text-white/80">
                    {s}
                  </li>
                ))}
              </ul>
            </section>
            <section className="rounded-xl border border-[#1B4FD8]/40 bg-[#1B4FD8]/10 px-4 py-3">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-[#7C9BFF]">Your vibe ✦</h3>
              <p className="mt-1 text-white">{review.headline}</p>
            </section>
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          autoFocus
          className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90"
        >
          Got it
        </button>
      </div>
    </div>
  )
}
