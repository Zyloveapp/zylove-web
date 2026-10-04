import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore, useBackLinkClass } from '../store/modeStore'
import { downloadReviewPdf, loadReviews, type SavedReview } from '../services/reviewHistory'

function formatDate(ms: number): string {
  return ms ? new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''
}

function scoreText(score: number): string {
  return score >= 80 ? 'text-emerald-400' : score >= 60 ? 'text-amber-400' : 'text-red-400'
}

function Bar({ name, score, accent }: { name: string; score: number; accent: string }) {
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-white/80">{name}</span>
        <span className={`font-semibold ${scoreText(score)}`}>{score}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${accent}`} style={{ width: `${Math.min(100, Math.max(0, score))}%` }} />
      </div>
    </div>
  )
}

// Saved profile reviews for the current mode only, newest first.
export default function ReviewHistory() {
  const backLinkClass = useBackLinkClass()
  const navigate = useNavigate()
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const key = `${uid}:${mode}`
  const [loaded, setLoaded] = useState<{ key: string; reviews: SavedReview[] | null } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const accent = mode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    loadReviews(uid, mode)
      .then((reviews) => !cancelled && setLoaded({ key, reviews }))
      .catch(() => !cancelled && setLoaded({ key, reviews: null }))
    return () => {
      cancelled = true
    }
  }, [uid, mode, key])

  async function download(r: SavedReview) {
    if (!r.pdfPath) return
    setDownloading(r.reviewId)
    setDownloadError(null)
    try {
      await downloadReviewPdf(r.pdfPath)
    } catch (err) {
      console.error('PDF download failed:', err)
      setDownloadError(r.reviewId)
    } finally {
      setDownloading(null)
    }
  }

  const state = loaded?.key === key ? loaded : null

  return (
    <div className="min-h-[calc(100dvh-7rem)] lg:min-h-[calc(100dvh-7.5rem)] bg-gray-950 px-4 py-6 text-white">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate(-1)} className={`text-sm font-medium ${backLinkClass} hover:text-white`}>
            ← Back
          </button>
          <h1 className="text-2xl font-bold">Profile reviews</h1>
        </div>

        <section className="rounded-2xl border border-white/10 bg-white/5">
          {state === null ? (
            <p className="px-5 py-4 text-sm text-white/40">Loading…</p>
          ) : state.reviews === null ? (
            <p className="px-5 py-4 text-sm text-red-400">Couldn't load your reviews. Try again later.</p>
          ) : state.reviews.length === 0 ? (
            <p className="px-5 py-4 text-sm text-white/40">No reviews yet. Tap 'How's my profile?' to get started.</p>
          ) : (
            <ul className="divide-y divide-white/5">
              {state.reviews.map((r) => {
                const expanded = open === r.reviewId
                return (
                  <li key={r.reviewId}>
                    <div className="flex items-center gap-3 px-5 py-4">
                      <button
                        type="button"
                        onClick={() => setOpen(expanded ? null : r.reviewId)}
                        aria-expanded={expanded}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <span className={`text-2xl font-bold ${scoreText(r.overallScore)}`}>{r.overallScore}</span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{formatDate(r.createdAt)}</span>
                          <span className="mt-0.5 inline-block rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/60">
                            {mode === 'play' ? '🔴 Play' : '🔵 Spark'}
                          </span>
                        </span>
                      </button>
                      {r.pdfPath && (
                        <button
                          type="button"
                          onClick={() => void download(r)}
                          disabled={downloading === r.reviewId}
                          className={`shrink-0 text-sm font-medium ${backLinkClass} hover:text-white disabled:opacity-50`}
                        >
                          {downloading === r.reviewId ? 'Downloading…' : 'Download PDF →'}
                        </button>
                      )}
                    </div>
                    {downloadError === r.reviewId && (
                      <p className="px-5 pb-3 text-sm text-red-400">Couldn't download the PDF. Try again.</p>
                    )}
                    {expanded && (
                      <div className="space-y-3 px-5 pb-5">
                        {r.sections.map((s) => (
                          <Bar key={s.name} name={s.name} score={s.score} accent={accent} />
                        ))}
                        {r.photos && <Bar name="Photos" score={r.photos.score} accent={accent} />}
                        {r.topSuggestion && (
                          <div className="mt-2 rounded-xl border border-white/10 bg-white/5 p-3">
                            <p className="text-xs font-semibold uppercase tracking-widest text-white/40">Top suggestion</p>
                            <p className="mt-1 text-sm text-white/85">{r.topSuggestion}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
