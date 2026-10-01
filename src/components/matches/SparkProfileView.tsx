import { useEffect, useState } from 'react'
import ProfileDetails from '../discover/ProfileDetails'
import { actionErrorMessage, type DiscoverProfile } from '../../services/discover'
import { dismissSpark, likeBackSpark, loadSparkProfile, type SparkEntry } from '../../services/sparks'

interface SparkProfileViewProps {
  uid: string
  spark: SparkEntry
  matched: boolean
  onClose: () => void
  onMatched: (matchId: string, name: string) => void
}

type Loaded = { likerUid: string; profile: DiscoverProfile }

export default function SparkProfileView({ uid, spark, matched, onClose, onMatched }: SparkProfileViewProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadSparkProfile(spark)
      .catch(() => spark.profile)
      .then((profile) => {
        if (!cancelled) setLoaded({ likerUid: spark.likerUid, profile })
      })
    return () => {
      cancelled = true
    }
  }, [spark])

  const profile = loaded?.likerUid === spark.likerUid ? loaded.profile : spark.profile
  const photo = profile.photoURLs?.[0]
  const revealed = matched || spark.isBot

  async function handleMatch() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const matchId = await likeBackSpark(uid, spark, profile)
      onMatched(matchId, profile.displayName ?? 'someone')
    } catch (err) {
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
        <button type="button" onClick={onClose} className="text-sm text-white/60 hover:text-white">
          ← Back
        </button>
        <span className={`text-sm ${spark.isWeeklySpark ? 'text-[#F59E0B]' : 'text-white/40'}`}>
          {spark.isWeeklySpark ? '✦ Weekly Spark' : 'Someone likes you ✦'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <div className="relative mb-8 aspect-[4/5] w-full max-w-sm overflow-hidden rounded-2xl bg-gradient-to-br from-[#1B4FD8]/60 to-white/10">
            {photo && (
              <img
                src={photo}
                alt=""
                className={`h-full w-full object-cover ${revealed ? '' : 'scale-110 blur-2xl'}`}
              />
            )}
            {!revealed && (
              <span className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
                Photos unlock when you match
              </span>
            )}
          </div>
          <ProfileDetails profile={profile} mode={spark.mode} />
        </div>
      </div>

      {!matched && (
        <div className="shrink-0 border-t border-white/10 px-6 py-4">
          <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
            {error && <p className="text-center text-sm text-red-400">{error}</p>}
            <button
              type="button"
              onClick={handleMatch}
              disabled={busy}
              className="w-full rounded-xl bg-[#1B4FD8] px-5 py-3 font-semibold text-white transition-opacity disabled:opacity-50"
            >
              ✦ It's a match
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              disabled={busy}
              className="text-sm text-white/50 underline hover:text-white/70 disabled:opacity-50"
            >
              Not for me
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
