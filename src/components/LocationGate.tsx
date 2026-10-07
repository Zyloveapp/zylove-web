import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import { LocationLimitError, lastLocationDenied, requestLocation, saveUserLocation } from '../services/location'
import { subscribeAccountView } from '../services/subscription'
import { isAdmin as checkAdmin } from '../services/adminPhotos'
import LocationHelp from './LocationHelp'

type Permission = 'checking' | 'granted' | 'prompt' | 'denied'
// What's shown: the feed, a spinner, or the ask.
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

function forgetGranted(): void {
  try {
    sessionStorage.removeItem(GRANTED_KEY)
  } catch {
    // ignore
  }
}

// Private windows that refuse storage writes (older Safari, some locked-down
// browsers). Modern Safari and Chrome allow storage in private mode, so this
// only catches some private windows.
function isPrivateBrowser(): boolean {
  try {
    localStorage.setItem('zylove_storage_test', '1')
    localStorage.removeItem('zylove_storage_test')
    return false
  } catch {
    return true
  }
}

// Explore needs a location to build the feed: the first-time ask. Once a
// location is saved (the summary in private/account) children render, and
// that saved location is what Explore uses — the browser's permission isn't
// checked again and the position isn't re-read; it changes only through
// Settings → Update location. With nothing saved, a full-page ask in their
// place (only Explore uses this, so nav, chat and settings stay reachable).
// Permission already granted but nothing saved: the position is fetched and
// saved without a tap.
export default function LocationGate({ children }: { children: ReactNode }) {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [permission, setPermission] = useState<Permission>(() => (grantedThisSession() ? 'granted' : 'checking'))
  // Whether a location is saved; null until the docs have loaded.
  const [saved, setSaved] = useState<{ uid: string; value: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  // "Try again" from the blocked view didn't get a location either.
  const [stillBlocked, setStillBlocked] = useState(false)
  // Why the last save failed: 'failed', or the server's limit message.
  const [saveError, setSaveError] = useState<string | false>(false)
  // Admins (the admin auth claim) get a small link to preview the gate.
  const [isAdmin, setIsAdmin] = useState(false)
  const [preview, setPreview] = useState<'prompt' | 'denied' | 'private' | null>(null)
  const [privateBrowser] = useState(isPrivateBrowser)
  const play = useModeStore((s) => s.mode) === 'play'
  // One automatic save attempt per mount.
  const autoSaveTried = useRef(false)

  useEffect(() => {
    if (!uid) return
    void checkAdmin(uid).then(setIsAdmin)
    return subscribeAccountView(
      uid,
      (d) => setSaved({ uid, value: typeof d.locationLat === 'number' && typeof d.locationLng === 'number' }),
      // Can't read the doc: don't lock Explore over it.
      () => setSaved({ uid, value: true }),
    )
  }, [uid])

  // The browser's permission, kept live: revoked in settings → gate again.
  useEffect(() => {
    if (!navigator.permissions?.query) {
      if (!grantedThisSession()) setPermission('prompt')
      return
    }
    let cancelled = false
    let status: PermissionStatus | null = null
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((s) => {
        if (cancelled) return
        status = s
        // Safari's "Ask" reports 'prompt' every visit; a position this
        // session counts as granted.
        if (s.state !== 'prompt' || !grantedThisSession()) setPermission(s.state)
        s.onchange = () => {
          if (s.state !== 'granted') forgetGranted()
          setPermission(s.state)
        }
      })
      .catch(() => !cancelled && !grantedThisSession() && setPermission('prompt'))
    return () => {
      cancelled = true
      if (status) status.onchange = null
    }
  }, [])

  const hasSaved = saved?.uid === uid ? saved.value : null

  // Gets a position and saves it. The gate opens when the saved location
  // shows up in private/account, not before.
  async function locate(): Promise<void> {
    const retry = permission === 'denied'
    setBusy(true)
    setStillBlocked(false)
    setSaveError(false)
    const location = await requestLocation()
    if (!location) {
      // No position but not refused (timed out, no fix — common on Macs
      // locating over Wi-Fi): retry, not "blocked".
      if (permission === 'granted' || !lastLocationDenied()) setSaveError('failed')
      else {
        setPermission('denied')
        setStillBlocked(retry)
      }
      setBusy(false)
      return
    }
    markGranted()
    setPermission('granted')
    try {
      if (uid) await saveUserLocation(location)
    } catch (err) {
      console.warn('[location] save failed', err)
      setSaveError(err instanceof LocationLimitError ? err.message : 'failed')
    }
    setBusy(false)
  }

  // Allowed already, nothing saved (an earlier visit never saved, or the
  // save failed): fetch and save without asking.
  useEffect(() => {
    if (permission !== 'granted' || hasSaved !== false || autoSaveTried.current) return
    autoSaveTried.current = true
    void locate()
    // locate reads current state when called.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission, hasSaved])

  let state: GateState
  if (preview === 'private') state = 'denied'
  else if (preview) state = preview
  else if (hasSaved === null) state = 'checking'
  else if (hasSaved) state = 'granted'
  else if (permission === 'checking') state = 'checking'
  else if (permission === 'denied') state = 'denied'
  // Granted but still saving (or the save failed): the ask, with its status.
  else state = 'prompt'

  const allow = () => void locate()
  const setState = (s: 'prompt' | 'denied' | 'granted') => setPreview(s === 'granted' ? null : s)

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

  // Blocked in a private window: Try again and the settings steps can't help
  // there, so point them at their regular browser instead.
  if (denied && (privateBrowser || preview === 'private')) {
    return (
      <div className="flex min-h-[calc(100dvh-7rem)] flex-col items-center justify-center bg-gray-950 px-6 py-10 text-center lg:min-h-[calc(100dvh-7.5rem)]">
        <span className="text-6xl" aria-hidden>
          📍
        </span>
        <h1 className="mt-5 text-2xl font-bold text-white">We need your location</h1>
        <div className="mt-3 max-w-xs space-y-3 text-white/60">
          <p>Zylove requires location to show you real people nearby and verify your city.</p>
          <p>You're in a private browser — location is blocked by default in private mode.</p>
          <p>Open zylove.app in your regular browser instead.</p>
          <p>
            Your privacy is protected regardless of browser mode — we never share your location with other users or store
            your exact coordinates.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            window.location.href = 'https://zylove.app'
          }}
          className={`mt-8 w-full max-w-xs rounded-full px-6 py-3.5 font-semibold text-white transition-opacity hover:opacity-90 ${
            play ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
          }`}
        >
          Open in regular browser →
        </button>
        <p className="mt-3 max-w-xs text-xs text-white/40">Zylove protects your privacy. Private browsing isn't required.</p>
        {isAdmin && preview && (
          <button type="button" onClick={() => setState('granted')} className="mt-6 text-xs text-white/30 underline hover:text-white/60">
            Admin: close preview
          </button>
        )}
      </div>
    )
  }

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

      {saveError && !denied && (
        <p className="mt-4 max-w-xs text-sm text-red-400">
          {saveError === 'failed' ? "Couldn't get your location. Check your connection and try again." : saveError}
        </p>
      )}

      {!denied && (
        <button
          type="button"
          onClick={() => void allow()}
          disabled={busy}
          className={`mt-8 w-full max-w-xs rounded-full px-6 py-3.5 font-semibold text-white transition-colors disabled:opacity-60 ${
            play ? 'bg-[#E03131] hover:bg-[#c42a2a]' : 'bg-[#1B4FD8] hover:bg-[#1640b0]'
          }`}
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
      {isAdmin && (
        <button type="button" onClick={() => setPreview('private')} className="mt-2 text-xs text-white/30 underline hover:text-white/60">
          Admin: preview private-browser view
        </button>
      )}
      {isAdmin && preview && (
        <button type="button" onClick={() => setState('granted')} className="mt-2 text-xs text-white/30 underline hover:text-white/60">
          Admin: close preview
        </button>
      )}

      {denied && (
        <div className="mt-8 w-full max-w-xs space-y-3 text-left text-sm text-white/50">
          {stillBlocked && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">
              Still blocked — your browser didn't share your location. Follow the steps below, then try again.
            </p>
          )}
          <LocationHelp />
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
