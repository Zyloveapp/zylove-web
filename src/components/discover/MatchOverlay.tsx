import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import type { Mode } from '../../store/modeStore'
import { fetchCompatibility, fetchMyProfile, type ArchetypeMatch } from '../../services/discover'
import SparkleIcon from '../icons/SparkleIcon'

const AUTO_DISMISS_MS = 5000

export interface NewMatch {
  matchId: string
  theirUid: string
  theirName: string
  theirPhoto: string | null
  mode: Mode
}

function Avatar({ photo, name }: { photo: string | null; name: string }) {
  return photo ? (
    <img src={photo} alt="" className="h-20 w-20 rounded-full object-cover ring-2 ring-[#1B4FD8]" />
  ) : (
    <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white/10 text-2xl font-semibold text-white/70 ring-2 ring-[#1B4FD8]">
      {name.charAt(0).toUpperCase() || '✦'}
    </span>
  )
}

// Full-screen "It's a Spark" celebration (web version of mobile's
// MatchAnimation). Leads to the chat or the matches list; with no action it
// goes to the matches list after 5 seconds.
export default function MatchOverlay({ match }: { match: NewMatch }) {
  const navigate = useNavigate()
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [myPhoto, setMyPhoto] = useState<string | null>(null)
  const [archetype, setArchetype] = useState<ArchetypeMatch | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => navigate('/matches'), AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [navigate])

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    fetchMyProfile(uid)
      .then((me) => {
        if (!cancelled) setMyPhoto(me?.photoURLs?.[0] ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [uid])

  // Cached from the compatibility block, so this is usually instant.
  // Archetypes come from Spark data only.
  useEffect(() => {
    if (match.mode !== 'spark') return
    let cancelled = false
    fetchCompatibility(match.theirUid)
      .then((r) => {
        const a = r.tier1?.archetype
        if (!cancelled && a && a.confidence > 0.4) setArchetype(a)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [match.mode, match.theirUid])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="It's a Spark"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gray-950 bg-[radial-gradient(circle_at_50%_35%,rgba(27,79,216,0.28),transparent_60%)] px-6 text-center"
    >
      <div className="flex items-center gap-5">
        <Avatar photo={myPhoto} name="You" />
        <SparkleIcon className="h-6 w-6 text-[#1B4FD8]" />
        <Avatar photo={match.theirPhoto} name={match.theirName} />
      </div>

      {archetype && (
        <div className="mt-6 max-w-sm">
          <p className="text-sm font-semibold text-[#1B4FD8]">✦ {archetype.label}</p>
          {archetype.copy && <p className="mt-1 text-sm text-white/60">{archetype.copy}</p>}
        </div>
      )}

      <h2 className="mt-8 text-3xl font-bold text-white">It's a Spark</h2>
      <p className="mt-2 text-white/60">{match.theirName} and you are a match.</p>

      <div className="mt-10 flex w-full max-w-xs flex-col gap-3">
        <button
          type="button"
          onClick={() => navigate(`/chat/${match.matchId}`)}
          className="w-full rounded-xl bg-[#1B4FD8] px-5 py-3 font-semibold text-white transition-opacity hover:opacity-90"
        >
          Start the conversation →
        </button>
        <button
          type="button"
          onClick={() => navigate('/matches')}
          className="w-full rounded-xl border border-white/15 px-5 py-3 font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-white"
        >
          See your matches
        </button>
      </div>
    </div>
  )
}
