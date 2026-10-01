import { useEffect, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import type { Mode } from '../../store/modeStore'
import { fetchCompatibility, fetchMyProfile, type ArchetypeMatch } from '../../services/discover'
import SparkleIcon from '../icons/SparkleIcon'

const AUTO_DISMISS_MS = 8000
const SPARKLE_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315]

export interface NewMatch {
  // null while the match is still being created (Sparks shows the overlay
  // before likeBack returns); "Chat now" stays disabled until it's set.
  matchId: string | null
  theirUid: string
  theirName: string
  theirPhoto: string | null
  mode: Mode
}

function Avatar({ photo, name, className }: { photo: string | null; name: string; className: string }) {
  const base = `h-[120px] w-[120px] shrink-0 rounded-full ring-4 ring-[#1B4FD8] ${className}`
  return photo ? (
    <img src={photo} alt="" className={`${base} object-cover`} />
  ) : (
    <span className={`${base} flex items-center justify-center bg-white/10 text-4xl font-semibold text-white/70`}>
      {name.charAt(0).toUpperCase() || '✦'}
    </span>
  )
}

// Full-screen "Sparks are flying" celebration (web version of mobile's
// MatchAnimation). Leads to the chat or the matches list; with no action it
// goes to the matches list when the timer bar runs out.
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
      aria-label="Sparks are flying"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gray-950 bg-[radial-gradient(circle_at_50%_40%,rgba(27,79,216,0.2),transparent_65%)] px-6 text-center"
    >
      <div className="flex items-center gap-4">
        <Avatar photo={myPhoto} name="You" className="zy-slide-from-left" />
        <div className="relative flex h-8 w-8 items-center justify-center">
          {SPARKLE_ANGLES.map((angle) => (
            <span
              key={angle}
              aria-hidden
              className="zy-burst pointer-events-none absolute text-sm text-[#7C9BFF]"
              style={{ '--zy-angle': `${angle}deg` } as CSSProperties}
            >
              ✦
            </span>
          ))}
          <SparkleIcon className="zy-pulse h-8 w-8 text-[#1B4FD8]" />
        </div>
        <Avatar photo={match.theirPhoto} name={match.theirName} className="zy-slide-from-right" />
      </div>

      <h2 className="mt-10 text-3xl font-bold text-white">Sparks are flying ✦</h2>
      <p className="mt-2 text-lg text-white/60">You both felt it.</p>

      {archetype && (
        <div className="mt-4 max-w-sm">
          <p className="text-sm font-semibold text-[#1B4FD8]">✦ {archetype.label}</p>
          {archetype.copy && <p className="mt-1 text-sm text-white/50">{archetype.copy}</p>}
        </div>
      )}

      <div className="mt-8 flex w-full max-w-sm flex-col gap-3">
        <button
          type="button"
          disabled={!match.matchId}
          onClick={() => match.matchId && navigate(`/chat/${match.matchId}`)}
          className="w-full rounded-xl bg-[#1B4FD8] py-4 text-lg font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Chat now →
        </button>
        <button
          type="button"
          onClick={() => navigate('/matches')}
          className="w-full rounded-xl border border-white/20 py-4 text-base text-white/70 transition-colors hover:bg-white/5 hover:text-white"
        >
          Chat later
        </button>
      </div>

      <div className="fixed inset-x-0 bottom-0 h-1 bg-white/5">
        <div className="zy-timer h-full bg-[#1B4FD8]" style={{ animationDuration: `${AUTO_DISMISS_MS}ms` }} />
      </div>
    </div>
  )
}
