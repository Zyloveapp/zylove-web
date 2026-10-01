import { useEffect, useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore, type Mode } from '../store/modeStore'
import { isNewMatch, isUnread, subscribeLastRead, subscribeMatches, type MatchEntry } from '../services/matches'
import { subscribeSparks } from '../services/sparks'
import SparkleIcon from './icons/SparkleIcon'

// Heights reserved by the bars: Header h-12 on top, this bar h-16 at the
// bottom. Pages use h-[calc(100dvh-7rem)] to fit between them.

function CompassIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-6 w-6" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" strokeLinejoin="round" />
    </svg>
  )
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-6 w-6" aria-hidden>
      <path
        d="M12 20s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.65-7 10-7 10Z"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-6 w-6" aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" strokeLinecap="round" />
    </svg>
  )
}

const LINKS: { to: string; label: string; icon: ReactNode }[] = [
  { to: '/discover', label: 'Discover', icon: <CompassIcon /> },
  { to: '/matches', label: 'Matches', icon: <HeartIcon /> },
  { to: '/sparks', label: 'Sparks', icon: <SparkleIcon /> },
  { to: '/profile', label: 'Profile', icon: <PersonIcon /> },
]

// Live dot flags for the current mode, using the same listeners as the
// Matches and Sparks pages.
//   Sparks:  any live (not dismissed or expired) like in the queue.
//   Matches: any unread conversation, or a match from the last 7 days that
//            nobody has written to yet.
function useBadges(uid: string, mode: Mode): { sparks: boolean; matches: boolean } {
  const key = `${uid}:${mode}`
  const [sparks, setSparks] = useState<{ key: string; any: boolean } | null>(null)
  const [matches, setMatches] = useState<{ key: string; list: MatchEntry[]; at: number } | null>(null)
  const [lastRead, setLastRead] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    if (!uid) return
    return subscribeSparks(
      uid,
      mode,
      (list) => setSparks({ key, any: list.length > 0 }),
      () => setSparks({ key, any: false }),
    )
  }, [uid, mode, key])

  useEffect(() => {
    if (!uid) return
    return subscribeMatches(
      uid,
      mode,
      (list) => setMatches({ key, list, at: Date.now() }),
      () => setMatches({ key, list: [], at: 0 }),
    )
  }, [uid, mode, key])

  useEffect(() => {
    if (!uid) return
    return subscribeLastRead(uid, setLastRead)
  }, [uid])

  return {
    sparks: sparks?.key === key && sparks.any,
    matches:
      matches?.key === key &&
      matches.list.some((m) => (!m.ended && isUnread(m, uid, lastRead)) || isNewMatch(m, matches.at)),
  }
}

// Bottom tab bar on every screen size; the top of the page belongs to Header.
export default function Nav() {
  const user = useAuthStore((s) => s.user)
  const mode = useModeStore((s) => s.mode)
  const badges = useBadges(user?.uid ?? '', mode)
  if (!user) return null
  const activeColor = mode === 'play' ? 'text-[#E03131]' : 'text-[#1B4FD8]'
  const dotColor = mode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
  const dot: Record<string, boolean> = { '/matches': badges.matches, '/sparks': badges.sparks }

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 h-16 border-t border-white/10 bg-gray-950">
      <div className="mx-auto flex h-full max-w-xl">
        {LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
                isActive ? activeColor : 'text-white/40 hover:text-white/70'
              }`
            }
          >
            <span className="relative">
              {l.icon}
              {dot[l.to] && (
                <span className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ${dotColor}`} aria-label="New" />
              )}
            </span>
            {l.label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
