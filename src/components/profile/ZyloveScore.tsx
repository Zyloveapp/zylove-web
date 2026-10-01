import { useEffect, useState } from 'react'
import { useAuthStore } from '../../store/authStore'
import { subscribeScore, subscribeScoreAccess, type ScoreSummary } from '../../services/zyloveScore'
import { TIER_META } from '../../types/zyloveScore'

const RING_RADIUS = 52
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function ScoreRing({ score, color }: { score: number; color: string }) {
  const filled = (Math.max(0, Math.min(100, score)) / 100) * RING_CIRCUMFERENCE
  return (
    <svg viewBox="0 0 120 120" className="h-32 w-32 shrink-0 -rotate-90" role="img" aria-label={`Score ${score} out of 100`}>
      <circle cx="60" cy="60" r={RING_RADIUS} fill="none" stroke="currentColor" strokeWidth="10" className="text-white/10" />
      <circle
        cx="60"
        cy="60"
        r={RING_RADIUS}
        fill="none"
        stroke={color}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${RING_CIRCUMFERENCE}`}
      />
      <text
        x="60"
        y="60"
        transform="rotate(90 60 60)"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-white text-[28px] font-bold"
      >
        {score}
      </text>
    </svg>
  )
}

// Sparkline of the score after each recent review.
function Trend({ points, color }: { points: number[]; color: string }) {
  const w = 200
  const h = 40
  const min = Math.min(...points)
  const range = Math.max(Math.max(...points) - min, 1)
  const path = points
    .map((p, i) => `${(i / (points.length - 1)) * w},${h - ((p - min) / range) * (h - 4) - 2}`)
    .join(' ')
  const change = points[points.length - 1] - points[0]
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between text-xs text-white/40">
        <span>Last {points.length} reviews</span>
        <span className={change >= 0 ? 'text-emerald-400' : 'text-amber-400'}>
          {change >= 0 ? '▲' : '▼'} {Math.abs(change)}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 h-10 w-full" preserveAspectRatio="none" aria-hidden>
        <polyline points={path} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

// Private to its owner; others only ever see the outcome (tier badges).
export default function ZyloveScore() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [unlocked, setUnlocked] = useState<boolean | null>(null)
  const [score, setScore] = useState<ScoreSummary | null | undefined>(undefined)

  useEffect(() => {
    if (!uid) return
    return subscribeScoreAccess(uid, setUnlocked)
  }, [uid])

  useEffect(() => {
    if (!uid || !unlocked) return
    return subscribeScore(uid, setScore, () => setScore(null))
  }, [uid, unlocked])

  const heading = <h2 className="text-sm font-semibold uppercase tracking-wide text-white/40">Zylove Score</h2>

  if (unlocked === false) {
    return (
      <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
        {heading}
        <p className="mt-3 text-white">See how you show up. 🔒</p>
        <p className="mt-1 text-sm text-white/60">
          Your Zylove Score reflects how matches experience talking with you. Unlock it with Spark+.
        </p>
      </section>
    )
  }

  if (unlocked === null || score === undefined) {
    return (
      <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
        {heading}
        <div className="mt-4 h-32 animate-pulse rounded-xl bg-white/5" />
      </section>
    )
  }

  const tier = TIER_META[score?.tier ?? 'new']

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
      {heading}
      {score === null ? (
        <div className="mt-3">
          <p className="text-white">
            {TIER_META.new.emoji} {TIER_META.new.label}
          </p>
          <p className="mt-1 text-sm text-white/60">
            {TIER_META.new.description}. Your score appears after matches review your conversations.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-5">
            <ScoreRing score={score.score} color={tier.color} />
            <div>
              <p className="text-lg font-semibold" style={{ color: tier.color }}>
                {tier.emoji} {tier.label}
              </p>
              <p className="mt-1 text-sm text-white/60">{tier.description}</p>
              <p className="mt-2 text-xs text-white/40">
                {score.reviewCount} {score.reviewCount === 1 ? 'review' : 'reviews'}
              </p>
            </div>
          </div>
          {score.history.length >= 2 && <Trend points={score.history} color={tier.color} />}
        </>
      )}
    </section>
  )
}
