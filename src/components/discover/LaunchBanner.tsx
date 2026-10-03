import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../../services/firebase'

const DISMISSED_KEY = 'zylove_bot_banner_dismissed'
const COMPLETE_SEEN_KEY = 'zylove_launch_complete_seen_at'
const COMPLETE_SHOW_MS = 24 * 60 * 60 * 1000

function storage(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage
  } catch {
    return null
  }
}

// When this browser first saw the circle complete; stamped on first sight.
function completeSeenAt(): number {
  const store = storage('local')
  const saved = Number(store?.getItem(COMPLETE_SEEN_KEY))
  if (saved > 0) return saved
  const now = Date.now()
  store?.setItem(COMPLETE_SEEN_KEY, String(now))
  return now
}

// Explore transparency note, live from config/launch.botsActive: while bots
// are on, say so (with the real-member count from publicStats/founding);
// once they're off, say every profile is real, for 24 hours.
export default function LaunchBanner() {
  const [botsActive, setBotsActive] = useState<boolean | null>(null)
  const [members, setMembers] = useState<{ members: number; capacity: number } | null>(null)
  const [dismissed, setDismissed] = useState(() => storage('session')?.getItem(DISMISSED_KEY) === '1')
  // Page-load time and, once bots are off, when this browser first saw that.
  const [loadedAt] = useState(() => Date.now())
  const [completeSince, setCompleteSince] = useState<number | null>(null)

  useEffect(
    () =>
      onSnapshot(
        doc(db, 'config/launch'),
        (snap) => {
          const active = snap.data()?.botsActive !== false
          setBotsActive(active)
          if (!active) setCompleteSince(completeSeenAt())
        },
        () => setBotsActive(null),
      ),
    [],
  )

  useEffect(
    () =>
      onSnapshot(
        doc(db, 'publicStats/founding'),
        (snap) => {
          const d = snap.data()
          setMembers({
            members: typeof d?.members === 'number' ? d.members : 0,
            capacity: typeof d?.capacity === 'number' && d.capacity > 0 ? d.capacity : 100,
          })
        },
        () => setMembers(null),
      ),
    [],
  )

  if (botsActive === null) return null

  if (!botsActive) {
    if (completeSince === null || loadedAt - completeSince > COMPLETE_SHOW_MS) return null
    return (
      <div className="mx-4 mb-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80">
        ✦ Austin founding circle is complete. Every profile you see is a real person.
      </div>
    )
  }

  if (dismissed) return null
  return (
    <button
      type="button"
      onClick={() => {
        storage('session')?.setItem(DISMISSED_KEY, '1')
        setDismissed(true)
      }}
      aria-label="Dismiss"
      className="mx-4 mb-4 block w-[calc(100%-2rem)] rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left text-sm text-white/80"
    >
      <span className="block">
        ✦ Building Austin's dating community. Some profiles are Zylove curated — real conversations, real compatibility
        scores, curated for you to experience Zylove while the network grows.
      </span>
      {members && (
        <span className="mt-1 block text-xs text-white/40">
          ✦ {members.members} of {members.capacity} real members have joined · tap to dismiss
        </span>
      )}
    </button>
  )
}
