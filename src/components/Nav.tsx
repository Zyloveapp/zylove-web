import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'

// Heights reserved by the bars: desktop top bar h-14, mobile bottom bar h-16.
// Pages use h-[calc(100dvh-4rem)] lg:h-[calc(100dvh-3.5rem)] to fit between them.

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

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-6 w-6" aria-hidden>
      <path d="M12 3c.6 4.6 3.4 7.4 9 9-5.6 1.6-8.4 4.4-9 9-.6-4.6-3.4-7.4-9-9 5.6-1.6 8.4-4.4 9-9Z" strokeLinejoin="round" />
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

export default function Nav() {
  const user = useAuthStore((s) => s.user)
  const mode = useModeStore((s) => s.mode)
  if (!user) return null

  return (
    <>
      {/* Desktop: top bar */}
      <header className="sticky top-0 z-40 hidden h-14 border-b border-white/10 bg-gray-950 lg:block">
        <div className="relative flex h-full items-center justify-between px-6">
          <span className="font-semibold text-white">✦ Zylove</span>
          <nav className="absolute left-1/2 flex -translate-x-1/2 gap-8">
            {LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) =>
                  `text-sm font-medium transition-colors ${isActive ? 'text-white' : 'text-white/40 hover:text-white/70'}`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <span className="rounded-full bg-white/10 px-3 py-1 text-sm text-white">
            {mode === 'play' ? '🔴 Play' : '🔵 Spark'}
          </span>
        </div>
      </header>

      {/* Mobile: bottom bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex h-16 border-t border-white/10 bg-gray-950 lg:hidden">
        {LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                isActive ? 'text-[#1B4FD8]' : 'text-white/40'
              }`
            }
          >
            {l.icon}
            {l.label}
          </NavLink>
        ))}
      </nav>
    </>
  )
}
