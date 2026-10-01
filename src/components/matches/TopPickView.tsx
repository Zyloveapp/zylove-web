import { useState } from 'react'
import ProfileDetails from '../discover/ProfileDetails'
import { actionErrorMessage, likeProfile, passProfile, type TopPick } from '../../services/discover'
import type { Mode } from '../../store/modeStore'

interface TopPickViewProps {
  uid: string
  pick: TopPick
  mode: Mode
  onClose: () => void
  // Like or pass recorded; the pick leaves the list. matchId when it matched.
  onDone: (result: { liked: boolean; matchId: string | null }) => void
}

// Full profile for a Top Pick, with Explore's like / pass actions.
export default function TopPickView({ uid, pick, mode, onClose, onDone }: TopPickViewProps) {
  const { profile } = pick
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const photo = profile.photoURLs?.[0]

  async function act(like: boolean) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (like) {
        const result = await likeProfile(uid, mode, profile)
        // Same fallback as Explore: the match id is the sorted uid pair.
        const matchId = result.matched ? (result.matchId ?? [uid, profile.uid].sort().join('_')) : null
        onDone({ liked: true, matchId })
      } else {
        await passProfile(uid, mode, profile.uid)
        onDone({ liked: false, matchId: null })
      }
    } catch (err) {
      setError(actionErrorMessage(err))
      setBusy(false)
    }
  }

  const accent = mode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-gray-950 text-white">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3 lg:px-6">
        <button type="button" onClick={onClose} className="text-sm text-white/60 hover:text-white">
          ← Back
        </button>
        <span className="text-sm font-semibold text-[#F59E0B]">✦ Top Pick</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <div className="relative mb-8 aspect-[4/5] w-full max-w-sm overflow-hidden rounded-2xl bg-white/5">
            {photo && <img src={photo} alt="" className="h-full w-full object-cover" />}
          </div>
          <ProfileDetails profile={profile} mode={mode} autoRevealScore />
        </div>
      </div>

      <div className="shrink-0 border-t border-white/10 px-6 py-4">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
          {error && <p className="text-center text-sm text-red-400">{error}</p>}
          <button
            type="button"
            onClick={() => act(true)}
            disabled={busy}
            className={`w-full rounded-xl px-5 py-3 font-semibold text-white transition-opacity disabled:opacity-50 ${accent}`}
          >
            {mode === 'play' ? '✦ Send a Flame ✦' : '✦ Send a Spark ✦'}
          </button>
          <button
            type="button"
            onClick={() => act(false)}
            disabled={busy}
            className="text-sm text-white/50 underline hover:text-white/70 disabled:opacity-50"
          >
            Pass
          </button>
        </div>
      </div>
    </div>
  )
}
