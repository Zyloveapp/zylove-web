// The Zylove Score ring: a 0–100 arc with the score in the middle.
const RING_RADIUS = 64
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export default function ScoreRing({ score, color }: { score: number; color: string }) {
  const filled = (Math.max(0, Math.min(100, score)) / 100) * RING_CIRCUMFERENCE
  return (
    <div className="relative h-40 w-40 shrink-0">
      <svg viewBox="0 0 150 150" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="75" cy="75" r={RING_RADIUS} fill="none" stroke="currentColor" strokeWidth="12" className="text-white/10" />
        <circle
          cx="75"
          cy="75"
          r={RING_RADIUS}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${RING_CIRCUMFERENCE}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-bold" style={{ color }}>
          {score}
        </span>
        <span className="text-xs text-white/40">/100</span>
      </div>
    </div>
  )
}
