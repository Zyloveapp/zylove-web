import { useEffect, useState } from 'react'
import { useBackLinkClass } from '../../store/modeStore'
import { Link } from 'react-router-dom'
import ProfileDetails from '../discover/ProfileDetails'
import SparkleIcon from '../icons/SparkleIcon'
import { actionErrorMessage, type DiscoverProfile } from '../../services/discover'
import { dismissSpark, likeBackSpark, loadSparkProfile, type SparkEntry } from '../../services/sparks'
import { loadPlayProfile, parsePlayProfile } from '../../services/playProfile'
import { playNameOf } from '../../services/displayNames'

interface SparkProfileViewProps {
  uid: string
  spark: SparkEntry
  matched: boolean
  onClose: () => void
  // Fired on tap, before likeBack returns, so the overlay can show instantly.
  onMatchStart: (name: string, photo: string | null) => void
  onMatched: (matchId: string) => void
  onMatchFailed: () => void
}

type Loaded = { likerUid: string; profile: DiscoverProfile }

export default function SparkProfileView({
  uid,
  spark,
  matched,
  onClose,
  onMatchStart,
  onMatched,
  onMatchFailed,
}: SparkProfileViewProps) {
  const backLinkClass = useBackLinkClass()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  // Linked during this view (the parent's `matched` updates via its listener).
  const [linked, setLinked] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A Flame (Play like) shows the liker's Play profile: their live
  // playProfile/data, or failing that the Play fields saved with the like.
  // Spark likes show the full root profile as before.
  useEffect(() => {
    let cancelled = false
    const isFlame = spark.mode === 'play'
    Promise.all([
      loadSparkProfile(spark).catch(() => spark.profile),
      isFlame ? loadPlayProfile(spark.likerUid) : Promise.resolve(null),
    ]).then(([profile, play]) => {
      if (cancelled) return
      // Only the snapshot's Play fields: its name, photos and prompts are Spark's.
      const { playBio, spiceLevel, playInterestTags, playNonNegotiables } = spark.profile as Record<string, unknown>
      const fallback = playBio || spiceLevel ? parsePlayProfile({ playBio, spiceLevel, playInterestTags, playNonNegotiables }) : null
      const playProfile = isFlame ? (play ?? fallback ?? undefined) : undefined
      // Play shows the Play name everywhere the details read displayName.
      const displayName = isFlame ? playNameOf(profile, playProfile) || 'Someone' : profile.displayName
      setLoaded({ likerUid: spark.likerUid, profile: { ...profile, playProfile, displayName } })
    })
    return () => {
      cancelled = true
    }
  }, [spark])

  const current = loaded?.likerUid === spark.likerUid ? loaded : null
  const profile = current?.profile ?? spark.profile
  // A like sent in Play: red, Play copy, Play profile and report.
  const isFlame = spark.mode === 'play'
  // Play: only a Play photo (none while it loads — the snapshot's is Spark's).
  const photo = isFlame ? (current ? profile.playProfile?.photoURLs[0] : undefined) : profile.photoURLs?.[0]
  // Unmatched likers stay anonymous (curated profiles too), like their card.
  // (A Flame's name waits for the Play profile: the snapshot's is Spark's.)
  const anonymous = (!matched && !linked) || (isFlame && !current)
  const headerName = (!anonymous && profile.displayName?.trim()) || 'Someone'

  async function handleMatch() {
    if (busy) return
    setBusy(true)
    setError(null)
    // A Flame's name only once its Play profile is in — the snapshot's is Spark's.
    onMatchStart((isFlame && !current ? '' : profile.displayName) || 'someone', photo ?? null)
    try {
      const matchId = await likeBackSpark(uid, spark, profile)
      setLinked(true)
      onMatched(matchId)
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
      await dismissSpark(uid, spark.likerUid)
      onClose()
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
          {spark.isWeeklySpark
            ? '✦ Weekly Spark'
            : isFlame
              ? `🔥 ${headerName} wants to play. You in?`
              : `${headerName} feels a Spark. Do you?`}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <div
            className={`relative mb-8 aspect-[4/5] w-full max-w-sm overflow-hidden rounded-2xl bg-gradient-to-br to-white/10 ${
              isFlame ? 'from-[#E03131]/60' : 'from-[#1B4FD8]/60'
            }`}
          >
            {photo && <img src={photo} alt="" className="h-full w-full object-cover" />}
          </div>
          <ProfileDetails profile={profile} mode={spark.mode} autoRevealScore anonymous={anonymous} />
        </div>
      </div>

      {(matched || linked) && (
        <div className="shrink-0 border-t border-white/10 px-6 py-4 text-center">
          <Link
            to={`/profile/${spark.likerUid}`}
            className={`text-sm font-semibold hover:text-white ${isFlame ? 'text-[#E03131]' : 'text-[#7C9BFF]'}`}
          >
            View their profile →
          </Link>
        </div>
      )}

      {!matched && !linked && (
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
