import { useEffect, useState } from 'react'
import { useAuthStore } from '../../store/authStore'
import { useModeStore } from '../../store/modeStore'
import { setVisibility, subscribeVisibility, type Visibility, type VisibilityState } from '../../services/visibility'

const OPTIONS: { value: Visibility; emoji: string; label: string; description: string; dot: string }[] = [
  { value: 'active', emoji: '🟢', label: 'Active', description: "You're visible in discovery", dot: 'bg-emerald-500' },
  {
    value: 'hidden',
    emoji: '👻',
    label: 'Hidden',
    description: 'Hidden from discovery. Matches can still reach you.',
    dot: 'bg-gray-400',
  },
  { value: 'paused', emoji: '☕', label: 'On a break', description: 'Your profile is on a break.', dot: 'bg-amber-500' },
]

// Visibility for the current mode. Each mode is set independently, so pausing
// Play leaves Spark untouched (mobile's core pause design).
export default function VisibilityControl() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const mode = useModeStore((s) => s.mode)
  const [state, setState] = useState<VisibilityState | null>(null)
  const [saving, setSaving] = useState<Visibility | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!uid) return
    return subscribeVisibility(uid, setState, () => setError(true))
  }, [uid])

  async function choose(v: Visibility) {
    setSaving(v)
    setError(false)
    try {
      await setVisibility(mode, v)
    } catch {
      setError(true)
    } finally {
      setSaving(null)
    }
  }

  const current = state ? state[mode] : null
  const meta = OPTIONS.find((o) => o.value === current)
  const modeName = mode === 'play' ? 'Play' : 'Spark'

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-white/40">{modeName} visibility</h2>
      {meta ? (
        <p className="mt-3 flex items-center gap-2 text-white">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot}`} aria-hidden />
          <span className="font-semibold">{meta.label}</span>
          <span className="text-sm text-white/60">— {meta.description}</span>
        </p>
      ) : (
        <div className="mt-3 h-6 w-48 animate-pulse rounded bg-white/10" />
      )}
      <div className="mt-4 grid grid-cols-3 gap-2">
        {OPTIONS.map((o) => {
          const selected = o.value === current
          return (
            <button
              key={o.value}
              type="button"
              disabled={current === null || saving !== null || selected}
              onClick={() => choose(o.value)}
              aria-pressed={selected}
              className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-sm transition-colors disabled:cursor-default ${
                selected
                  ? 'border-[#1B4FD8] bg-[#1B4FD8]/15 font-semibold text-white'
                  : 'border-white/10 text-white/60 hover:bg-white/10 disabled:opacity-50'
              }`}
            >
              <span aria-hidden>{saving === o.value ? '…' : o.emoji}</span>
              {o.label}
            </button>
          )
        })}
      </div>
      {error && <p className="mt-3 text-sm text-red-400">Couldn't update visibility. Try again.</p>}
    </section>
  )
}
