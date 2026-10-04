import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import { isPlayOnlyUser } from '../services/playOnboarding'
import { rememberAfterLogin } from '../services/afterLogin'

type ProfileStatus = 'complete' | 'incomplete' | 'error'

function Spinner() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-gray-800" />
    </div>
  )
}

export default function AuthGuard() {
  const user = useAuthStore((s) => s.user)
  const loading = useAuthStore((s) => s.loading)
  const uid = user?.uid
  const location = useLocation()

  // Keyed by uid so a result for a previous user is never reused.
  const [result, setResult] = useState<{ uid: string; status: ProfileStatus } | null>(null)
  const [attempt, setAttempt] = useState(0)

  // Onboarding is complete only when users/{uid} has onboardingComplete: true.
  // Mobile creates the doc early (identity lock at slide 2), so existence alone
  // would let half-onboarded users through.
  useEffect(() => {
    if (!uid) return
    let cancelled = false
    getDoc(doc(db, 'users', uid))
      .then(async (snap) => {
        const complete = snap.exists() && snap.data().onboardingComplete === true
        // Play-only (Play path, no Spark profile): into Play before the app
        // renders, so Spark never flashes. The Play lock asks for the PIN.
        if (complete && snap.data()?.onboardingPath === 'play' && (await isPlayOnlyUser(uid).catch(() => false))) {
          if (!cancelled) useModeStore.getState().setMode('play')
        }
        if (!cancelled) setResult({ uid, status: complete ? 'complete' : 'incomplete' })
      })
      .catch(() => {
        if (!cancelled) setResult({ uid, status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [uid, attempt])

  if (loading) return <Spinner />
  if (!user) {
    // A founder-claim text tapped while signed out comes back here after login.
    if (location.pathname === '/claim-founder') rememberAfterLogin(location.pathname + location.search)
    return <Navigate to="/login" replace />
  }

  const status = result?.uid === user.uid ? result.status : null
  if (status === null) return <Spinner />

  // Don't treat a failed read as "no profile": that would send existing users
  // back through onboarding, which overwrites their photos and prompts.
  if (status === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-gray-700">We couldn't load your profile.</p>
        <button
          type="button"
          onClick={() => {
            setResult(null)
            setAttempt((n) => n + 1)
          }}
          className="rounded-lg bg-gray-900 px-4 py-2 font-medium text-white"
        >
          Try again
        </button>
      </div>
    )
  }

  if (status === 'incomplete') return <Navigate to="/onboarding" replace />

  return <Outlet />
}
