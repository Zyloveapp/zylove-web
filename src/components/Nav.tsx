import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
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

// Bottom tab bar on every screen size; the top of the page belongs to Header.
export default function Nav() {
  const user = useAuthStore((s) => s.user)
  const mode = useModeStore((s) => s.mode)
  if (!user) return null
  const activeColor = mode === 'play' ? 'text-[#E03131]' : 'text-[#1B4FD8]'

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
            {l.icon}
            {l.label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
