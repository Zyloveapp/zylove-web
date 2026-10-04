import { MAX_RANGE_AGE, MIN_AGE } from './onboarding/types'

// Age range slider: 18 to 65, where the top end means "65 and over" (saved
// as MAX_RANGE_AGE so older profiles aren't cut off).
const SLIDER_MAX = 65

export default function AgeRangeSlider({ min, max, onChange }: { min: number; max: number; onChange: (min: number, max: number) => void }) {
  const hi = Math.min(max, SLIDER_MAX)
  const pct = (v: number) => ((v - MIN_AGE) / (SLIDER_MAX - MIN_AGE)) * 100
  const label = (v: number) => (v >= SLIDER_MAX ? `${SLIDER_MAX}+` : String(v))
  return (
    <div>
      <div className="mb-4 flex items-center justify-center gap-3">
        <span className="min-w-[4.5rem] rounded-full border border-white/15 bg-white/5 px-4 py-2 text-center text-xl font-semibold">
          {label(min)}
        </span>
        <span className="text-white/40">to</span>
        <span className="min-w-[4.5rem] rounded-full border border-white/15 bg-white/5 px-4 py-2 text-center text-xl font-semibold">
          {label(hi)}
        </span>
      </div>
      <div className="zy-dual-range relative h-10">
        <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-white/10" />
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[color:var(--zy-accent,#1B4FD8)]"
          style={{ left: `${pct(min)}%`, right: `${100 - pct(hi)}%` }}
        />
        <input
          type="range"
          aria-label="Minimum age"
          min={MIN_AGE}
          max={SLIDER_MAX}
          value={min}
          onChange={(e) => onChange(Math.min(Number(e.target.value), hi - 1), max)}
        />
        <input
          type="range"
          aria-label="Maximum age"
          min={MIN_AGE}
          max={SLIDER_MAX}
          value={hi}
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), min + 1)
            onChange(min, v >= SLIDER_MAX ? MAX_RANGE_AGE : v)
          }}
        />
      </div>
    </div>
  )
}
