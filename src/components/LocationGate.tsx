import { useEffect, useState, type ReactNode } from 'react'
import { useAuthStore } from '../store/authStore'
import { requestLocation, saveUserLocation } from '../services/location'

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

  useEffect(() => {
    if (state !== 'checking') return
    let cancelled = false
    if (!navigator.permissions?.query) {
      setState('prompt')
      return
    }
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((s) => !cancelled && setState(s.state))
      .catch(() => !cancelled && setState('prompt'))
    return () => {
      cancelled = true
    }
  }, [state])

  async function allow() {
    setBusy(true)
    const location = await requestLocation()
    if (location) {
      if (uid) await saveUserLocation(uid, location).catch(() => {})
      markGranted()
      setState('granted')
    } else {
      setState('denied')
    }
    setBusy(false)
  }

  if (state === 'granted') return <>{children}</>
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
        Sorry, we need your location to show you the right people nearby. Zylove uses your location to curate your feed — we
        never share your exact location with anyone.
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

      {denied && (
        <div className="mt-8 w-full max-w-xs space-y-3 text-left text-sm text-white/50">
          <p className="text-white/70">Location access was blocked. To enable:</p>
          <p>
            <span className="font-semibold text-white/70">iPhone/Safari:</span> Tap AA in your browser bar → Website Settings →
            Location → Allow
          </p>
          <p>
            <span className="font-semibold text-white/70">Android/Chrome:</span> Tap the lock icon in your address bar →
            Permissions → Location → Allow
          </p>
          <p className="text-xs text-white/40">Or open your phone's Settings → Safari/Chrome → Location</p>
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
