import { useEffect, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import type { Mode } from '../../store/modeStore'
import { fetchCompatibility, fetchMyProfile, type ArchetypeMatch } from '../../services/discover'
import SparkleIcon from '../icons/SparkleIcon'

// First wave: 16 sparkles as the photos meet. Second wave, 300ms later:
// smaller and shorter, on the angles between the first.
const FIRST_WAVE = Array.from({ length: 16 }, (_, i) => i * 22.5)
const SECOND_WAVE = FIRST_WAVE.map((a) => a + 11.25)
// Background drift: [left %, top %, delay ms], staggered across the 3s loop.
const FLOATERS: [number, number, number][] = [
  [12, 70, 0],
  [28, 40, 500],
  [46, 82, 1000],
  [64, 55, 1500],
  [80, 75, 2000],
  [90, 35, 2500],
]

export interface NewMatch {
  // null while the match is still being created (Sparks shows the overlay
  // before likeBack returns); "Chat now" stays disabled until it's set.
  matchId: string | null
  theirUid: string
  theirName: string
  theirPhoto: string | null
  mode: Mode
}

// The wrapper slides in; the photo inside pulses its glow (separate elements
// because each needs its own CSS animation).
function Avatar({ photo, name, className }: { photo: string | null; name: string; className: string }) {
  const base = 'zy-glow h-[120px] w-[120px] rounded-full'
  return (
    <span className={`shrink-0 ${className}`}>
      {photo ? (
        <img src={photo} alt="" className={`${base} block object-cover`} />
      ) : (
        <span className={`${base} flex items-center justify-center bg-white/10 text-4xl font-semibold text-white/70`}>
          {name.charAt(0).toUpperCase() || '✦'}
        </span>
      )}
    </span>
  )
}

// Full-screen "Sparks are flying" celebration (web version of mobile's
// MatchAnimation). Stays up until the user picks "Chat now" or "Chat later".
export default function MatchOverlay({ match }: { match: NewMatch }) {
  const navigate = useNavigate()
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [myPhoto, setMyPhoto] = useState<string | null>(null)
  const [archetype, setArchetype] = useState<ArchetypeMatch | null>(null)

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
      className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-gray-950 bg-[radial-gradient(circle_at_50%_40%,rgba(27,79,216,0.2),transparent_65%)] px-6 text-center"
    >
      {FLOATERS.map(([left, top, delay]) => (
        <span
          key={left}
          aria-hidden
          className="zy-float pointer-events-none absolute text-xs text-[#7C9BFF]"
          style={{ left: `${left}%`, top: `${top}%`, '--zy-delay': `${delay}ms` } as CSSProperties}
        >
          ✦
        </span>
      ))}

      <div className="relative flex items-center gap-4">
        <Avatar photo={myPhoto} name="You" className="zy-slide-from-left" />
        <div className="relative flex h-8 w-8 items-center justify-center">
          {FIRST_WAVE.map((angle) => (
            <span
              key={angle}
              aria-hidden
              className="zy-burst pointer-events-none absolute text-sm text-[#7C9BFF]"
              style={{ '--zy-angle': `${angle}deg` } as CSSProperties}
            >
              ✦
            </span>
          ))}
          {SECOND_WAVE.map((angle) => (
            <span
              key={angle}
              aria-hidden
              className="zy-burst pointer-events-none absolute text-[10px] text-white/80"
              style={{ '--zy-angle': `${angle}deg`, '--zy-distance': '60px', '--zy-delay': '700ms' } as CSSProperties}
            >
              ✦
            </span>
          ))}
          <SparkleIcon className="zy-pulse h-8 w-8 text-[#1B4FD8]" />
        </div>
        <Avatar photo={match.theirPhoto} name={match.theirName} className="zy-slide-from-right" />
      </div>

      <h2 className="zy-shimmer mt-10 text-3xl font-bold">Sparks are flying ✦</h2>
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

    </div>
  )
}
