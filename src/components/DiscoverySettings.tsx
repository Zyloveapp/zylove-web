import { useEffect, useRef, useState } from 'react'
import { doc, onSnapshot, updateDoc } from 'firebase/firestore'
import { db } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import AgeRangeSlider from './AgeRangeSlider'

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
const DEFAULT_AGES = { min: 21, max: 45 }
// Slider drags write once they settle, not on every step.
const AGE_SAVE_DELAY_MS = 500

function toAges(d: Record<string, unknown> | undefined): { min: number; max: number } {
  const min = typeof d?.ageMin === 'number' ? d.ageMin : DEFAULT_AGES.min
  const max = typeof d?.ageMax === 'number' ? d.ageMax : DEFAULT_AGES.max
  return min < max ? { min, max } : DEFAULT_AGES
}

function toOption(v: unknown): string {
  if (v === null) return 'none'
  return typeof v === 'number' && v > 0 ? String(v) : DEFAULT
}

// Settings → Discovery: max distance (users/{uid}.radiusMiles) and age range
// (ageMin / ageMax) for the Explore feed, in both modes.
export default function DiscoverySettings() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [loaded, setLoaded] = useState<{ uid: string; value: string; ages: { min: number; max: number } } | null>(null)
  const [error, setError] = useState(false)
  // The range while it's being dragged, ahead of the saved value.
  const [draftAges, setDraftAges] = useState<{ min: number; max: number } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      doc(db, 'users', uid),
      (snap) => setLoaded({ uid, value: toOption(snap.data()?.radiusMiles), ages: toAges(snap.data()) }),
      () => setError(true),
    )
  }, [uid])

  const value = loaded?.uid === uid ? loaded.value : null
  const ages = draftAges ?? (loaded?.uid === uid ? loaded.ages : null)

  useEffect(() => () => clearTimeout(saveTimer.current), [])

  function changeAges(min: number, max: number) {
    setDraftAges({ min, max })
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setError(false)
      try {
        await updateDoc(doc(db, 'users', uid), { ageMin: min, ageMax: max })
      } catch {
        setError(true)
      } finally {
        setDraftAges(null)
      }
    }, AGE_SAVE_DELAY_MS)
  }

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
      <div className="border-t border-white/5 px-5 py-4">
        <span className="mb-3 block font-medium">Age range</span>
        {ages ? (
          <AgeRangeSlider min={ages.min} max={ages.max} onChange={changeAges} />
        ) : (
          <div className="h-24 animate-pulse rounded-xl bg-white/5" />
        )}
      </div>
      {error && <p className="px-5 pb-4 text-sm text-red-400">Couldn't save that. Try again.</p>}
    </section>
  )
}
