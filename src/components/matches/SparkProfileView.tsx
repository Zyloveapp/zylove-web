import { useState } from 'react'
import { useBackLinkClass } from '../../store/modeStore'
import { Link } from 'react-router-dom'
import SparkleIcon from '../icons/SparkleIcon'
import CuratedBadge from '../CuratedBadge'
import { actionErrorMessage } from '../../services/discover'
import { dismissSpark, likeBackSpark, type SparkEntry } from '../../services/sparks'
import { promptQuestion } from '../discover/labels'
import { useLikerPreview } from './useLikerPreview'
import StoredImg from '../StoredImg'

interface SparkProfileViewProps {
  spark: SparkEntry
  onClose: () => void
  // Fired on tap, before likeBack returns, so the overlay can show instantly.
  onMatchStart: (name: string, photo: string | null) => void
  // Once linked, the server says who they are (uid in Spark, Play ID in Play).
  onMatched: (matchId: string, partnerId: string) => void
  onMatchFailed: () => void
  onDismissed: () => void
}

// §4.A3: someone who liked you, before you link — their preview only
// (getLikerPreview: photo, first name, bio, prompts; a Flame's from their
// Play profile). No age, place, gender, badges or compatibility report: the
// app doesn't know who they are until the like back links you.
export default function SparkProfileView({ spark, onClose, onMatchStart, onMatched, onMatchFailed, onDismissed }: SparkProfileViewProps) {
  const backLinkClass = useBackLinkClass()
  const preview = useLikerPreview(spark.likeId)
  const [busy, setBusy] = useState(false)
  // Linked during this view: who they are, for "View their profile".
  const [partnerId, setPartnerId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A like sent in Play: red, Play copy, Play profile.
  const isFlame = spark.mode === 'play'
  const name = preview?.firstName || 'Someone'
  const photo = preview?.photo ?? null
  const prompts = preview?.prompts ?? []

  async function handleMatch() {
    if (busy) return
    setBusy(true)
    setError(null)
    onMatchStart(name, photo)
    try {
      const { matchId, partnerId: id } = await likeBackSpark(spark)
      setPartnerId(id)
      onMatched(matchId, id)
    } catch (err) {
      onMatchFailed()
      setError(actionErrorMessage(err))
      setBusy(false)
    }
  }

  async function handleDismiss() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await dismissSpark(spark.likeId)
      onDismissed()
    } catch (err) {
      setError(actionErrorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-gray-950 text-white">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3 lg:px-6">
        <button type="button" onClick={onClose} className={`text-sm font-medium ${backLinkClass} hover:text-white`}>
          ← Back
        </button>
        <span className={`text-sm ${spark.isWeeklySpark ? 'text-[#F59E0B]' : 'text-white/40'}`}>
          {spark.isWeeklySpark ? '✦ Weekly Spark' : isFlame ? `🔥 ${name} wants to play. You in?` : `${name} feels a Spark. Do you?`}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
          <div
            className={`relative aspect-[4/5] w-full max-w-sm overflow-hidden rounded-2xl bg-gradient-to-br to-white/10 ${
              isFlame ? 'from-[#E03131]/60' : 'from-[#1B4FD8]/60'
            }`}
          >
            {photo && <StoredImg src={photo} alt="" className="h-full w-full object-cover" />}
          </div>
          <header className="border-b border-white/10 pb-6">
            <h2 className="text-4xl font-bold">{name}</h2>
            {preview?.curated && <CuratedBadge uid="" curated className="mt-2" />}
            {spark.compatibilityScore !== null && (
              <p className={`mt-2 text-sm font-semibold ${isFlame ? 'text-red-300' : 'text-[#9DB4FF]'}`}>
                {Math.round(spark.compatibilityScore)}% compatible
              </p>
            )}
          </header>
          {preview === null && <p className="text-sm text-white/50">This profile can't be shown right now.</p>}
          {preview?.bio && (
            <section>
              <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-widest text-white">About</h3>
              <p className="whitespace-pre-line text-lg leading-relaxed text-white/80">{preview.bio}</p>
            </section>
          )}
          {prompts.length > 0 && (
            <section>
              <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-widest text-white">In their own words</h3>
              <div className="space-y-5">
                {prompts.map((p) => (
                  <div key={p.promptId} className="border-l-2 border-white/10 pl-4">
                    <p className="text-sm text-white/30">{promptQuestion(p.promptId, p.question)}</p>
                    <p className="mt-1 text-base text-white">{p.answer}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {partnerId && (
        <div className="shrink-0 border-t border-white/10 px-6 py-4 text-center">
          <Link
            to={`/profile/${partnerId}`}
            className={`text-sm font-semibold hover:text-white ${isFlame ? 'text-[#E03131]' : 'text-[#7C9BFF]'}`}
          >
            View their profile →
          </Link>
        </div>
      )}

      {!partnerId && (
        <div className="shrink-0 border-t border-white/10 px-6 py-4">
          <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
            {error && <p className="text-center text-sm text-red-400">{error}</p>}
            <button
              type="button"
              onClick={handleMatch}
              disabled={busy}
              className={`flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 font-semibold text-white transition-opacity disabled:opacity-50 ${
                isFlame ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
              }`}
            >
              {isFlame ? (
                '🔥 Light it up'
              ) : (
                <>
                  <SparkleIcon className="h-5 w-5" />
                  It's a Spark
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              disabled={busy}
              className="text-sm text-white/50 underline hover:text-white/70 disabled:opacity-50"
            >
              {isFlame ? 'Not my vibe' : 'Not for me'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
