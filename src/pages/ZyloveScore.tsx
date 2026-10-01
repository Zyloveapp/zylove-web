import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { DEFAULT_SCORE, subscribeScore, type ScoreDetail } from '../services/zyloveScore'
import { SPARK_PERKS, TIER_META, getUnlockedPerks, type ZyloveScoreTier } from '../types/zyloveScore'
import { REVIEW_CATEGORY_DEFS } from '../types/reviewCategories'

// Web palette for the ring and tier label.
const TIER_COLOR: Record<ZyloveScoreTier, string> = {
  elite: '#E8B931', // gold
  trusted: '#1B4FD8', // cobalt
  great: '#1D9E75', // green
  good: '#3B82F6', // blue
  building: '#F59E0B', // amber
  new: '#888888', // gray
}

const TIPS: { emoji: string; tip: string }[] = [
  { emoji: '💎', tip: 'Be yourself — authentic profiles get better reviews' },
  { emoji: '💬', tip: 'Respond thoughtfully — quality over speed' },
  { emoji: '🛡', tip: 'Respect boundaries — always' },
  { emoji: '✍️', tip: 'Complete your profile — more detail = better matches' },
  { emoji: '✦', tip: 'Rate your conversations — participation points add up' },
]

const RING_RADIUS = 64
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function ScoreRing({ score, color }: { score: number; color: string }) {
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

function StatChip({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'good' | 'bad' }) {
  const color =
    tone === 'good' ? 'bg-emerald-500/10 text-emerald-300' : tone === 'bad' ? 'bg-red-500/10 text-red-300' : 'bg-white/5 text-white'
  return (
    <div className={`flex-1 rounded-xl px-3 py-3 text-center ${color}`}>
      <p className="text-xl font-bold">{value}</p>
      <p className="text-xs opacity-80">{label}</p>
    </div>
  )
}

type Loaded = { uid: string; score: ScoreDetail }

// Private to its owner; others only ever see the outcome (tier badges, perks).
export default function ZyloveScore() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!uid) return
    return subscribeScore(
      uid,
      (score) => setLoaded({ uid, score }),
      // Unreadable reads as "no reviews yet", like mobile.
      () => setLoaded({ uid, score: DEFAULT_SCORE }),
    )
  }, [uid])

  const page = 'min-h-[calc(100dvh-7rem)] bg-gray-950 text-white'

  if (loaded?.uid !== uid) {
    return (
      <div className={`flex items-center justify-center ${page}`}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }

  const s = loaded.score
  const tier = TIER_META[s.tier]
  const color = TIER_COLOR[s.tier]
  // Same as mobile: the first tier whose threshold is above the current score.
  const next = Object.values(TIER_META).find((t) => t.minScore > s.score) ?? null
  const unlocked = getUnlockedPerks(s.score)
  const qualities = s.topPositiveCategories
    .map((id) => REVIEW_CATEGORY_DEFS.find((c) => c.id === id))
    .filter((c) => c !== undefined)

  return (
    <div className={page}>
      <div className="mx-auto max-w-xl space-y-6 px-4 py-6">
        <header className="flex items-center justify-between">
          <Link to="/profile" className="text-xl text-white/50 hover:text-white" aria-label="Back to profile">
            ←
          </Link>
          <h1 className="text-xl font-bold">Your Zylove Score</h1>
          <span className="w-5" aria-hidden />
        </header>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="flex items-center gap-5">
            <ScoreRing score={s.score} color={color} />
            <div>
              <p className="text-xl font-semibold" style={{ color }}>
                {tier.emoji} {tier.label}
              </p>
              <p className="mt-1 text-sm text-white/60">{tier.description}</p>
            </div>
          </div>

          {next && (
            <div className="mt-5">
              <div className="flex justify-between text-sm">
                <span className="text-white/60">
                  Next tier: {next.label} ({next.minScore - s.score} pts away)
                </span>
                <span className="text-white/30">{next.minScore}/100</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, (s.score / next.minScore) * 100)}%`, backgroundColor: color }}
                />
              </div>
            </div>
          )}

          <div className="mt-5 flex gap-2">
            <StatChip label="Reviews" value={s.reviewCount} tone="neutral" />
            <StatChip label="Positive" value={s.positiveCount} tone="good" />
            <StatChip label="Flags" value={s.flagCount} tone={s.flagCount > 0 ? 'bad' : 'neutral'} />
          </div>
        </section>

        <p className="rounded-xl bg-white/5 px-4 py-3 text-sm text-white/60">
          🔒 Your Zylove Score is private. Others only see the perks it unlocks — never the number.
        </p>

        {qualities.length > 0 && (
          <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <h2 className="font-semibold">People say you're…</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {qualities.map((c) => (
                <span key={c.id} className="rounded-full bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-200">
                  {c.emoji} {c.label}
                </span>
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-white/50">Perks</h2>
          <ul className="space-y-2">
            {SPARK_PERKS.map((perk) => {
              const on = unlocked.includes(perk.id)
              return (
                <li
                  key={perk.id}
                  className={`flex items-center gap-4 rounded-xl border px-4 py-3 ${
                    on ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-white/10 bg-white/[0.03]'
                  }`}
                >
                  <div className="flex-1">
                    <p className={`font-medium ${on ? 'text-white' : 'text-white/60'}`}>
                      {on ? '' : '🔒 '}
                      {perk.label}
                    </p>
                    <p className="text-sm text-white/40">{perk.description}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                      on ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-white/40'
                    }`}
                  >
                    {on ? 'Active' : `${perk.pointsRequired}pts`}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
          <h2 className="font-semibold">How to improve your score</h2>
          <ul className="mt-3 space-y-3">
            {TIPS.map((t) => (
              <li key={t.tip} className="flex gap-3 text-sm text-white/70">
                <span aria-hidden>{t.emoji}</span>
                {t.tip}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
