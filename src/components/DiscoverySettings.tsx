import { useEffect, useState } from 'react'
import { doc, onSnapshot, updateDoc } from 'firebase/firestore'
import { db } from '../services/firebase'
import { useAuthStore } from '../store/authStore'

// Same choices as onboarding, plus no limit (stored as null).
const OPTIONS: { value: string; label: string }[] = [
  { value: '5', label: '5 mi' },
  { value: '10', label: '10 mi' },
  { value: '25', label: '25 mi' },
  { value: '50', label: '50 mi' },
  { value: '100', label: '100 mi' },
  { value: 'none', label: 'No limit' },
]
const DEFAULT = '25'

function toOption(v: unknown): string {
  if (v === null) return 'none'
  return typeof v === 'number' && v > 0 ? String(v) : DEFAULT
}

// Settings → Discovery: max distance for the Explore feed (users/{uid}.radiusMiles).
export default function DiscoverySettings() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [loaded, setLoaded] = useState<{ uid: string; value: string } | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      doc(db, 'users', uid),
      (snap) => setLoaded({ uid, value: toOption(snap.data()?.radiusMiles) }),
      () => setError(true),
    )
  }, [uid])

  const value = loaded?.uid === uid ? loaded.value : null

  async function change(next: string) {
    setError(false)
    try {
      await updateDoc(doc(db, 'users', uid), { radiusMiles: next === 'none' ? null : Number(next) })
    } catch {
      setError(true)
    }
  }

  // A saved value off the list (from another app) still shows.
  const options = value && !OPTIONS.some((o) => o.value === value) ? [{ value, label: `${value} mi` }, ...OPTIONS] : OPTIONS

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5">
      <h2 className="px-5 pt-4 text-xs font-semibold uppercase tracking-widest text-white/40">Discovery</h2>
      <label className="flex items-center justify-between gap-4 px-5 py-4">
        <span>
          <span className="block font-medium">Maximum distance</span>
          <span className="block text-sm text-white/40">Profiles without a location are always shown.</span>
        </span>
        <select
          value={value ?? DEFAULT}
          disabled={value === null}
          onChange={(e) => void change(e.target.value)}
          className="shrink-0 rounded-xl border border-white/10 bg-gray-900 px-3 py-2 text-white focus:border-white/30 focus:outline-none disabled:opacity-50"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="px-5 pb-4 text-sm text-red-400">Couldn't save that. Try again.</p>}
    </section>
  )
}
