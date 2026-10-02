import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../../services/firebase'

type Stats = { members: number; capacity: number }

// Live founding-circle progress from publicStats/founding (public, written
// only by assignFounderBadge). No doc yet means nobody has joined; a read
// error hides the counter rather than showing a wrong number.
export default function FoundingCounter() {
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(
    () =>
      onSnapshot(
        doc(db, 'publicStats/founding'),
        (snap) => {
          const d = snap.data()
          setStats({
            members: typeof d?.members === 'number' ? d.members : 0,
            capacity: typeof d?.capacity === 'number' && d.capacity > 0 ? d.capacity : 100,
          })
        },
        () => setStats(null),
      ),
    [],
  )

  if (!stats) return null
  const full = stats.members >= stats.capacity
  const pct = Math.min(100, (stats.members / stats.capacity) * 100)

  return (
    <div className="mx-auto mt-6 max-w-md text-center">
      <p className="text-sm font-medium text-[#B4C6FF]">
        {full
          ? '✦ Austin founding circle is complete. More cities coming.'
          : `✦ ${stats.members} of ${stats.capacity} founding members have joined Austin`}
      </p>
      <div
        className="mt-3 h-2 overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={stats.capacity}
        aria-valuenow={stats.members}
        aria-label="Austin founding circle"
      >
        <div className="h-full rounded-full bg-[#1B4FD8] transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
