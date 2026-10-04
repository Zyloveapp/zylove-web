import { Link } from 'react-router-dom'

const LINKS = [
  { to: '/', label: 'Home' },
  { to: '/join', label: 'Join' },
  { to: '/terms', label: 'Terms' },
  { to: '/privacy', label: 'Privacy' },
  { to: '/community', label: 'Community' },
  { to: '/contact', label: 'Contact' },
]

export default function PublicFooter() {
  return (
    <footer className="border-t border-white/10 px-4 py-10 text-center">
      <nav className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-white/50">
        {LINKS.map((l) => (
          <Link key={l.to} to={l.to} className="hover:text-white">
            {l.label}
          </Link>
        ))}
      </nav>
      <p className="mt-6 text-sm text-white/40">
        <span className="text-[#1B4FD8]">✦</span> Zylove · Launching city by city · 2026
      </p>
      <p className="mt-1 text-xs text-white/30">ZYLOVE™ trademark filed April 7, 2026</p>
    </footer>
  )
}
