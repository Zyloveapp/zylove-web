import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../../services/firebase'
import { useAuthStore } from '../../store/authStore'
import { BANNER_DISMISSED_KEY as DISMISSED_KEY, BANNER_RESET_EVENT } from '../../services/playSession'
import { FOUNDER_CAPACITY, cityConfigPath, cityStatsPath, getNearestCity, type ZyloveCity } from '../../config/cities'

const COMPLETE_SEEN_KEY = 'zylove_launch_complete_seen_at'
const COMPLETE_SHOW_MS = 24 * 60 * 60 * 1000
const EARLY_SEEN_KEY = 'zylove_early_modal_seen'
// How far outside coverage the "you're early" counter looks for a city.
const NEARBY_CITY_MILES = 150

function storage(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage
  } catch {
    return null
  }
}

// When this browser first saw the city's circle complete; stamped on first sight.
function completeSeenAt(cityId: string): number {
  const store = storage('local')
  const key = `${COMPLETE_SEEN_KEY}_${cityId}`
  const saved = Number(store?.getItem(key))
  if (saved > 0) return saved
  const now = Date.now()
  store?.setItem(key, String(now))
  return now
}

// The dismissal is per session and cleared by a Play inactivity lock.
function useDismissed(): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(() => storage('session')?.getItem(DISMISSED_KEY) === '1')
  useEffect(() => {
    const reset = () => setDismissed(false)
    window.addEventListener(BANNER_RESET_EVENT, reset)
    return () => window.removeEventListener(BANNER_RESET_EVENT, reset)
  }, [])
  return [
    dismissed,
    () => {
      storage('session')?.setItem(DISMISSED_KEY, '1')
      setDismissed(true)
    },
  ]
}

type Area = { city: ZyloveCity | null; nearby: ZyloveCity | null }

// Explore transparency note, by where the viewer is: inside a launch city,
// that city's founding circle; anywhere else, "you're early". Nothing shows
// until the user doc has a location — it's saved only after the browser
// grants it, often after Explore has loaded, and an unknown location must
// never read as "outside every city". Live, so it appears once saved.
export default function LaunchBanner() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [area, setArea] = useState<{ uid: string; area: Area } | null>(null)

  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        const d = snap.data()
        const lat = d?.locationLat
        const lng = d?.locationLng
        if (typeof lat !== 'number' || typeof lng !== 'number') return setArea(null)
        const city = getNearestCity(lat, lng)
        const nearby = city ? null : getNearestCity(lat, lng, NEARBY_CITY_MILES)
        // Same answer as before: keep the state so the banner doesn't remount
        // on every unrelated write to the user doc.
        setArea((prev) =>
          prev?.uid === uid && prev.area.city?.id === city?.id && prev.area.nearby?.id === nearby?.id
            ? prev
            : { uid, area: { city, nearby } },
        )
      },
      () => setArea(null),
    )
  }, [uid])

  if (area?.uid !== uid) return null
  return area.area.city ? <CityBanner city={area.area.city} /> : <EarlyBanner nearby={area.area.nearby} />
}

// Live from config/city_{id}.botsActive: while bots are on, say so (with the
// founder count from publicStats/city_{id}); once they're off, say every
// profile is real, for 24 hours.
function CityBanner({ city }: { city: ZyloveCity }) {
  const [botsActive, setBotsActive] = useState<boolean | null>(null)
  const [members, setMembers] = useState<{ members: number; capacity: number } | null>(null)
  const [dismissed, dismiss] = useDismissed()
  // Page-load time and, once bots are off, when this browser first saw that.
  const [loadedAt] = useState(() => Date.now())
  const [completeSince, setCompleteSince] = useState<number | null>(null)

  useEffect(
    () =>
      onSnapshot(
        doc(db, cityConfigPath(city.id)),
        (snap) => {
          const active = snap.data()?.botsActive !== false
          setBotsActive(active)
          if (!active) setCompleteSince(completeSeenAt(city.id))
        },
        () => setBotsActive(null),
      ),
    [city.id],
  )

  useEffect(
    () =>
      onSnapshot(
        doc(db, cityStatsPath(city.id)),
        (snap) => {
          const d = snap.data()
          setMembers({
            members: typeof d?.members === 'number' ? d.members : 0,
            capacity: typeof d?.capacity === 'number' && d.capacity > 0 ? d.capacity : FOUNDER_CAPACITY,
          })
        },
        () => setMembers(null),
      ),
    [city.id],
  )

  if (botsActive === null) return null

  if (!botsActive) {
    if (completeSince === null || loadedAt - completeSince > COMPLETE_SHOW_MS) return null
    return (
      <div className="mx-4 mb-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80">
        ✦ {city.name} founding circle is complete. Every profile you see is a real person.
      </div>
    )
  }

  if (dismissed) return null
  return (
    <button
      type="button"
      onClick={dismiss}
      aria-label="Dismiss"
      className="mx-4 mb-4 block w-[calc(100%-2rem)] rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left text-sm text-white/80"
    >
      <span className="block">✦ Building {city.name}'s dating community. Some profiles are Zylove curated while we grow.</span>
      {members && (
        <span className="mt-1 block text-xs text-white/40">
          ✦ {members.members} of {members.capacity} {city.name} founders have joined · tap to dismiss
        </span>
      )}
    </button>
  )
}

// Live member count for a city (publicStats/city_{id}); 0 until loaded.
function useCityMembers(city: ZyloveCity | null): number {
  const [members, setMembers] = useState(0)
  useEffect(() => {
    if (!city) return
    return onSnapshot(
      doc(db, cityStatsPath(city.id)),
      (snap) => {
        const m = snap.data()?.members
        setMembers(typeof m === 'number' ? m : 0)
      },
      () => setMembers(0),
    )
  }, [city])
  return members
}

// Outside every launch city: a one-time-per-session "you're early" screen,
// then a dismissible banner. nearby is the closest launch city within
// NEARBY_CITY_MILES, whose count stands in for theirs; with none, the
// numbers are the full 100.
function EarlyBanner({ nearby }: { nearby: ZyloveCity | null }) {
  const [modalOpen, setModalOpen] = useState(() => storage('session')?.getItem(EARLY_SEEN_KEY) !== '1')
  const [dismissed, dismiss] = useDismissed()
  const remaining = Math.max(0, FOUNDER_CAPACITY - useCityMembers(nearby))
  const goal = nearby
    ? `${nearby.name} needs ${remaining} more founders to go live`
    : `Your area needs ${FOUNDER_CAPACITY} founders to go live`

  function closeModal() {
    storage('session')?.setItem(EARLY_SEEN_KEY, '1')
    setModalOpen(false)
  }

  if (modalOpen) return <EarlyModal goal={nearby ? `${goal}.` : null} onClose={closeModal} />
  if (dismissed) return null
  return (
    <button
      type="button"
      onClick={dismiss}
      aria-label="Dismiss"
      className="mx-4 mb-4 block w-[calc(100%-2rem)] rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left text-sm text-white/80"
    >
      <span className="block">✦ Zylove is coming to your area. You're early — invite friends to unlock your city.</span>
      <span className="mt-1 block text-xs text-white/40">✦ {goal} · tap to dismiss</span>
    </button>
  )
}

// goal: the nearby city's line; null means "100 more people" for their area.
function EarlyModal({ goal, onClose }: { goal: string | null; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="early-title"
      className="fixed inset-0 z-[70] flex flex-col items-center justify-center overflow-y-auto bg-gray-950 px-6 py-10 text-center text-white"
    >
      <h2 id="early-title" className="text-4xl font-black tracking-tight">
        <span className="text-[#1B4FD8]">✦</span> You're early.
      </h2>
      <div className="mt-6 max-w-sm space-y-3 text-white/70">
        <p>Zylove is launching city by city, starting in Austin.</p>
        <p>You've just become one of the first people in your area to discover us.</p>
        <p className="font-semibold text-white">{goal ?? `${FOUNDER_CAPACITY} more people and your city goes live.`}</p>
        <p>In the meantime, explore our curated profiles to see what Zylove is all about.</p>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-8 w-full max-w-xs rounded-full bg-[#1B4FD8] px-6 py-3.5 font-semibold text-white transition-colors hover:bg-[#1640b0]"
      >
        Start exploring →
      </button>
      <p className="mt-4 text-sm text-white/40">Tell your friends — 100 people unlock your city 🔥</p>
    </div>,
    document.body,
  )
}
