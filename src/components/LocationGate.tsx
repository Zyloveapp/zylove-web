import { useEffect, useState, type ReactNode } from 'react'
import { useAuthStore } from '../store/authStore'
import { requestLocation, saveUserLocation } from '../services/location'
import { fetchPublicUserDoc } from '../services/publicUserDoc'

type GateState = 'checking' | 'granted' | 'prompt' | 'denied'

// Set once this tab gets a position, so browsers that report 'prompt' on
// every visit (Safari's "Ask") don't gate again until the next session.
const GRANTED_KEY = 'zylove_location_granted'

function grantedThisSession(): boolean {
  try {
    return sessionStorage.getItem(GRANTED_KEY) === '1'
  } catch {
    return false
  }
}

function markGranted(): void {
  try {
    sessionStorage.setItem(GRANTED_KEY, '1')
  } catch {
    // Storage unavailable: the gate may ask once more next visit.
  }
}

// Explore needs a location to build the feed. Renders children once the
// browser has granted geolocation; otherwise a full-page ask in their place
// (only Explore uses this, so nav, chat and settings stay reachable).
// Browsers without the Permissions API start at the ask.
export default function LocationGate({ children }: { children: ReactNode }) {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [state, setState] = useState<GateState>(() => (grantedThisSession() ? 'granted' : 'checking'))
  const [busy, setBusy] = useState(false)
  // "Try again" from the blocked view didn't get a location either.
  const [stillBlocked, setStillBlocked] = useState(false)
  // Admins (users/{uid}.isAdmin) get a small link to preview the gate.
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    fetchPublicUserDoc(uid).then((d) => !cancelled && setIsAdmin(d?.isAdmin === true))
    return () => {
      cancelled = true
    }
  }, [uid])

  useEffect(() => {
    if (state !== 'checking') return
    let cancelled = false
    if (!navigator.permissions?.query) {
      setState('prompt')
      return
    }
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((status) => {
        if (cancelled) return
        setState(status.state)
        // Allowed later from the browser's or phone's settings: let them in.
        status.onchange = () => {
          if (status.state === 'granted') setState('granted')
        }
      })
      .catch(() => !cancelled && setState('prompt'))
    return () => {
      cancelled = true
    }
  }, [state])

  // Asks for a position directly (getCurrentPosition), which brings up the
  // browser's own prompt wherever it's still allowed to ask. A browser that
  // has permanently blocked the site fails at once — the instructions are the
  // only way back then.
  async function allow() {
    const retry = state === 'denied'
    setBusy(true)
    setStillBlocked(false)
    const location = await requestLocation()
    if (location) {
      if (uid) await saveUserLocation(uid, location).catch(() => {})
      markGranted()
      setState('granted')
    } else {
      setState('denied')
      setStillBlocked(retry)
    }
    setBusy(false)
  }

  if (state === 'granted') {
    return (
      <>
        {children}
        {isAdmin && (
          <button
            type="button"
            onClick={() => setState('prompt')}
            title="Preview the location gate (admin)"
            className="fixed bottom-20 left-3 z-40 rounded-full border border-white/15 bg-gray-900/80 px-2 py-1 text-xs text-white/40 hover:text-white"
          >
            📍?
          </button>
        )}
      </>
    )
  }
  if (state === 'checking') {
    return (
      <div className="flex min-h-[calc(100dvh-7rem)] items-center justify-center bg-gray-950 lg:min-h-[calc(100dvh-7.5rem)]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }

  const denied = state === 'denied'
  return (
    <div className="flex min-h-[calc(100dvh-7rem)] flex-col items-center justify-center bg-gray-950 px-6 py-10 text-center lg:min-h-[calc(100dvh-7.5rem)]">
      <span className="text-6xl" aria-hidden>
        📍
      </span>
      <h1 className="mt-5 text-2xl font-bold text-white">We need your location</h1>
      <p className="mt-3 max-w-xs text-white/60">
        {denied
          ? "Location access was blocked. Here's how to enable it:"
          : 'Zylove uses your location to show you real people nearby. We never share your exact location.'}
      </p>

      {!denied && (
        <button
          type="button"
          onClick={() => void allow()}
          disabled={busy}
          className="mt-8 w-full max-w-xs rounded-full bg-[#1B4FD8] px-6 py-3.5 font-semibold text-white transition-colors hover:bg-[#1640b0] disabled:opacity-60"
        >
          {busy ? 'Waiting for location…' : 'Allow location →'}
        </button>
      )}

      {isAdmin && (
        <button
          type="button"
          onClick={() => {
            setStillBlocked(false)
            setState(denied ? 'prompt' : 'denied')
          }}
          className="mt-6 text-xs text-white/30 underline hover:text-white/60"
        >
          Admin: preview {denied ? 'first-ask' : 'blocked'} view
        </button>
      )}

      {denied && (
        <div className="mt-8 w-full max-w-xs space-y-3 text-left text-sm text-white/50">
          {stillBlocked && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">
              Still blocked — your browser didn't share your location. Follow the steps below, then try again.
            </p>
          )}
          <p>
            <span className="font-semibold text-white/70">iPhone/Safari:</span> Open your iPhone Settings → scroll to Safari →
            tap Location → select Allow
          </p>
          <p>
            <span className="font-semibold text-white/70">Android/Chrome:</span> Tap the lock icon in your address bar →
            Permissions → Location → Allow
          </p>
          <button
            type="button"
            onClick={() => void allow()}
            disabled={busy}
            className="mt-2 w-full rounded-full border border-white/15 px-6 py-3 text-center font-semibold text-white/80 hover:bg-white/5 disabled:opacity-60"
          >
            {busy ? 'Trying…' : 'Try again'}
          </button>
        </div>
      )}
    </div>
  )
}
