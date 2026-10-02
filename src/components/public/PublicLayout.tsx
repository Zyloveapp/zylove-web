import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import PublicFooter from './PublicFooter'
import Wordmark from './Wordmark'

// Shell for the signed-out pages (terms, privacy, community, join, contact).
export default function PublicLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-gray-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <Link to="/" aria-label="Zylove home">
            <Wordmark className="text-xl" />
          </Link>
          <Link to="/login" className="text-sm font-medium text-[#7C9BFF] hover:text-white">
            Sign in
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">{children}</main>
      <PublicFooter />
    </div>
  )
}
