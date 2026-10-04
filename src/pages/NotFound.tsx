import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import Wordmark from '../components/public/Wordmark'

// Any URL no route matches: a mistyped link, an old bookmark.
export default function NotFound() {
  const signedIn = useAuthStore((s) => s.user !== null)

  useEffect(() => {
    document.title = 'Page not found · Zylove'
    return () => {
      document.title = 'Zylove'
    }
  }, [])

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-gray-950 px-6 text-center text-white">
      <Link to="/" className="text-3xl">
        <Wordmark />
      </Link>
      <h1 className="mt-10 text-2xl font-bold">This page doesn't exist</h1>
      <p className="mt-3 max-w-xs text-white/60">The link may be old or mistyped. Let's get you back.</p>
      <Link
        to={signedIn ? '/discover' : '/'}
        className="mt-8 rounded-xl bg-[#1B4FD8] px-6 py-3 font-semibold text-white transition-opacity hover:opacity-90"
      >
        {signedIn ? 'Back to Explore →' : 'Go to Zylove →'}
      </Link>
    </div>
  )
}
