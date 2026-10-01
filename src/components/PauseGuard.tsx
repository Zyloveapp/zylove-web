import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import { isOnBreak, setVisibility, subscribeVisibility, type VisibilityState } from '../services/visibility'

// Covers every protected page with mobile's "You're on a break." screen while
// all of the user's modes are paused. Renders children underneath so state
// survives the round trip.
export default function PauseGuard() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const [state, setState] = useState<VisibilityState | null>(null)
  const [resuming, setResuming] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!uid) return
    // A failed read never locks the user out.
    return subscribeVisibility(uid, setState, () => setState(null))
  }, [uid])

  const onBreak = state !== null && isOnBreak(state)

  async function resume() {
    if (!state) return
    // Resume the mode being viewed; if the user doesn't have that mode, their own.
    const target = state.modes.includes(mode) ? mode : state.modes[0]
    setResuming(true)
    setError(false)
    try {
      await setVisibility(target, 'active')
    } catch {
      setError(true)
    } finally {
      setResuming(false)
    }
  }

  return (
    <>
      <Outlet />
      {onBreak && (
        <div
          className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-[#0a0a14] px-8 text-center text-white"
          role="dialog"
          aria-modal="true"
          aria-labelledby="on-break-title"
        >
          <p className="text-6xl" aria-hidden>
            ☕
          </p>
          <h1 id="on-break-title" className="mt-6 text-2xl font-bold tracking-wide">
            You're on a break.
          </h1>
          <p className="mt-3 max-w-sm leading-relaxed text-white/60">
            Everything is right where you left it — your matches, your conversations, your profile.
          </p>
          <p className="mt-4 max-w-sm leading-relaxed text-white/60">Nobody new will see you while you're gone.</p>
          <button
            type="button"
            onClick={resume}
            disabled={resuming}
            className="mt-10 rounded-full bg-[#1B4FD8] px-10 py-3.5 font-semibold tracking-wide text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            I'm back ✦
          </button>
          {error && <p className="mt-4 text-sm text-red-400">Couldn't resume. Try again.</p>}
        </div>
      )}
    </>
  )
}
