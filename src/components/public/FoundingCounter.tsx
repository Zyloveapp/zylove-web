import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../../services/firebase'
import { FOUNDER_CAPACITY } from '../../config/cities'

type Stats = { members: number; capacity: number }

// Below this many members the counter stays hidden: "0 of 100" (or "3 of
// 100") reads as an empty app rather than an early one.
const MIN_MEMBERS_SHOWN = 10

// Live founding-circle progress from publicStats/founding (public, written
// by the founder functions). That doc mirrors Austin, the first launch
// city, so the copy names Austin rather than claiming a total for every
// city. No doc yet means nobody has joined; a read error hides the counter
// rather than showing a wrong number.
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
            capacity: typeof d?.capacity === 'number' && d.capacity > 0 ? d.capacity : FOUNDER_CAPACITY,
          })
        },
        () => setStats(null),
      ),
    [],
  )

  if (!stats || stats.members < MIN_MEMBERS_SHOWN) return null
  const full = stats.members >= stats.capacity
  const pct = Math.min(100, (stats.members / stats.capacity) * 100)

  return (
    <div className="mx-auto mt-6 max-w-md text-center">
      <p className="text-sm font-medium text-[#B4C6FF]">
        {full
          ? "✦ Austin's founding circle is complete. More cities are opening."
          : `✦ ${stats.members} of ${stats.capacity} founding members have joined in Austin. More cities are opening.`}
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
