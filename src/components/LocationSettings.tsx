import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { MODE_ACCENT, useModeStore } from '../store/modeStore'
import { LocationLimitError, lastLocationDenied, requestLocation, saveUserLocation } from '../services/location'
import { subscribeAccountView } from '../services/subscription'
import LocationHelp from './LocationHelp'

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'denied' }

// Settings → Discovery → Location (both modes): the saved city and an
// "Update location" button — the only way the location changes once it's
// saved (Explore's gate takes the first one). The tap asks the browser, which
// shows the device's allow-location prompt the first time. Device location
// only; no manual entry.
export default function LocationSettings() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  // null until loaded; value null: nothing saved yet.
  const [label, setLabel] = useState<{ uid: string; value: string | null } | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    if (!uid) return
    return subscribeAccountView(
      uid,
      (d) => setLabel({ uid, value: typeof d.locationLabel === 'string' && d.locationLabel ? d.locationLabel : null }),
      () => setLabel({ uid, value: null }),
    )
  }, [uid])

  async function update() {
    setStatus({ kind: 'busy' })
    const position = await requestLocation()
    if (!position) {
      setStatus(lastLocationDenied() ? { kind: 'denied' } : { kind: 'error', text: "Couldn't get your location. Try again." })
      return
    }
    try {
      const saved = await saveUserLocation(position)
      const city = saved.label ?? (label?.uid === uid ? label.value : null)
      setStatus({
        kind: 'done',
        text: saved.changed
          ? city ? `Location updated to ${city}` : 'Location updated'
          : city ? `Your location is up to date — ${city}` : 'Your location is up to date',
      })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof LocationLimitError ? err.message : "Couldn't save your location. Try again." })
    }
  }

  const current = label?.uid === uid ? label.value : undefined
  const busy = status.kind === 'busy'

  return (
    <div className="px-5 pt-4 pb-4">
      <div className="flex items-center justify-between gap-4">
        <span>
          <span className="block font-medium">Location</span>
          <span className="block text-sm text-white/40" data-testid="location-label">
            {current === undefined ? '…' : (current ?? 'Not set yet')}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void update()}
          disabled={busy || !uid}
          className={`shrink-0 rounded-full ${MODE_ACCENT[mode].bg} px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60`}
        >
          {busy ? 'Locating…' : 'Update location'}
        </button>
      </div>
      <div aria-live="polite">
        {status.kind === 'done' && <p className="mt-3 text-sm text-emerald-400">{status.text}</p>}
        {status.kind === 'error' && <p className="mt-3 text-sm text-red-400">{status.text}</p>}
        {status.kind === 'denied' && (
          <div className="mt-3">
            <p className="text-sm text-amber-200">Location access is blocked. Here's how to enable it, then tap Update location again:</p>
            <LocationHelp className="mt-3" />
          </div>
        )}
      </div>
    </div>
  )
}
