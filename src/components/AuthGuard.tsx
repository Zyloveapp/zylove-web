import { useEffect, useState } from 'react'
import { signOutAndWipe } from '../services/signOut'
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
    <div className="flex min-h-screen items-center justify-center bg-gray-950">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
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
        if (complete && (await isPlayOnlyUser(uid).catch(() => false))) {
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
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-950 px-4 text-center text-white">
        <p className="text-white/70">We couldn't load your profile. Check your connection and try again.</p>
        <button
          type="button"
          onClick={() => {
            setResult(null)
            setAttempt((n) => n + 1)
          }}
          className="rounded-xl bg-[#1B4FD8] px-5 py-2.5 font-semibold text-white transition-opacity hover:opacity-90"
        >
          Try again
        </button>
        <button type="button" onClick={() => void signOutAndWipe({ keepChatKey: 'ifNoBackup' })} className="text-sm text-white/40 underline hover:text-white/70">
          Sign out
        </button>
      </div>
    )
  }

  if (status === 'incomplete') return <Navigate to="/onboarding" replace />

  return <Outlet />
}
