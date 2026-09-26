import { useEffect, useState } from 'react'
import { fetchCompatibility, type CompatibilityResult } from '../../services/discover'
import type { Mode } from '../../store/modeStore'
import { discoverTheme } from './theme'

// Up to 4 categories per mode, highest-weighted first (see scoring weights).
const CATEGORIES: Record<Mode, { key: string; label: string }[]> = {
  spark: [
    { key: 'valuesIntentions', label: 'Values & intentions' },
    { key: 'coreFit', label: 'Core fit' },
    { key: 'physicalPrefs', label: 'Physical' },
    { key: 'loveLanguages', label: 'Love languages' },
  ],
  play: [
    { key: 'nonNegotiables', label: 'Non-negotiables' },
    { key: 'physicalCompatibility', label: 'Physical' },
    { key: 'energyVibe', label: 'Energy & vibe' },
    { key: 'intentionsLimits', label: 'Intentions & limits' },
  ],
}

type LoadState = { uid: string; result: CompatibilityResult | null }

export default function CompatibilityBlock({ targetUid, mode }: { targetUid: string; mode: Mode }) {
  const [state, setState] = useState<LoadState | null>(null)
  const theme = discoverTheme(mode)

  useEffect(() => {
    let cancelled = false
    fetchCompatibility(targetUid)
      .then((result) => {
        if (!cancelled) setState({ uid: targetUid, result })
      })
      .catch(() => {
        if (!cancelled) setState({ uid: targetUid, result: null })
      })
    return () => {
      cancelled = true
    }
  }, [targetUid])

  if (state?.uid !== targetUid) {
    return (
      <div className="mt-4" aria-busy="true">
        <div className="h-12 w-24 animate-pulse rounded-lg bg-white/10" />
        <div className="mt-2 h-3 w-24 animate-pulse rounded bg-white/5" />
      </div>
    )
  }

  const result = state.result
  const score = mode === 'play' ? result?.playScore : result?.sparkScore
  if (!result || typeof score !== 'number') return null

  const breakdown = mode === 'play' ? result.breakdown?.play : result.breakdown?.spark
  const bars = CATEGORIES[mode]
    .map((c) => ({ ...c, value: breakdown?.[c.key] }))
    .filter((c): c is { key: string; label: string; value: number } => typeof c.value === 'number')
  const dealbreakers = result.triggeredDealbreakers ?? []

  return (
    <div className="mt-4">
      <p className={`text-5xl font-bold ${theme.scoreText}`}>{Math.round(score)}%</p>
      <p className="mt-1 text-xs uppercase tracking-widest text-white/30">Compatibility</p>

      {bars.length > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          {bars.map((b) => (
            <div key={b.key}>
              <p className="mb-1.5 text-xs text-white/40">{b.label}</p>
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full ${theme.barFill}`}
                  style={{ width: `${Math.min(100, Math.max(0, b.value))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {dealbreakers.length > 0 && <p className="mt-4 text-xs text-amber-400/60">⚠ Some dealbreakers flagged</p>}
    </div>
  )
}
