import { useEffect, useState, type ReactNode } from 'react'
import {
  fetchCompatibility,
  fetchMyProfile,
  type CompatibilityResult,
  type DiscoverProfile,
} from '../../services/discover'
import { useAuthStore } from '../../store/authStore'
import ProfileComparison from './ProfileComparison'
import { DEALBREAKER_LABELS, type Dealbreaker } from '../../types/profile'
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

// Every category, in scoring-weight order — used for "Why you match".
const ALL_CATEGORIES: Record<Mode, { key: string; label: string }[]> = {
  spark: [
    ...CATEGORIES.spark,
    { key: 'lifestyle', label: 'Lifestyle' },
    { key: 'personality', label: 'Personality' },
  ],
  play: CATEGORIES.play,
}

const INSIGHT_THRESHOLD = 60

function insightFor(value: number): string {
  if (value >= 90) return 'Strong alignment'
  if (value >= 80) return 'High compatibility'
  if (value >= 70) return 'Good match'
  return 'Moderate'
}

// Category-specific wording for "Why you match"; anything not listed falls
// back to the generic level words.
function categoryInsight(key: string, value: number, asymmetryGap: number | null): string {
  switch (key) {
    case 'valuesIntentions':
      return `${insightFor(value)} · You both value connection`
    case 'coreFit':
      if (asymmetryGap !== null && asymmetryGap < 10) return 'Well balanced'
      if (asymmetryGap !== null && asymmetryGap <= 20) return 'Complementary'
      return insightFor(value)
    case 'loveLanguages':
      return value > 70 ? 'You give what they need' : 'Different styles'
    default:
      return insightFor(value)
  }
}

// Mobile's score scale (green / cobalt / amber / red).
function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-400'
  if (score >= 60) return 'text-[#1B4FD8]'
  if (score >= 40) return 'text-amber-400'
  return 'text-red-400'
}

function scoreQualifier(score: number): string | null {
  if (score >= 80) return 'Strong match'
  if (score >= 60) return 'Good potential'
  if (score >= 40) return 'Worth exploring'
  return null
}

function dealbreakerLabel(id: string): string {
  return id in DEALBREAKER_LABELS ? DEALBREAKER_LABELS[id as Dealbreaker] : id.replace(/_/g, ' ')
}

// Categories scored from data the viewed profile may not have filled in.
// With nothing to score against, the server returns a neutral default, so
// these are hidden rather than shown as a misleading number.
function emptyCategories(p: DiscoverProfile): Set<string> {
  const empty = new Set<string>()
  const hasPhysical = (p.seekingBodyTypes?.length ?? 0) > 0 || Boolean(p.seekingHeightMinCm) || Boolean(p.seekingHeightMaxCm)
  if (!hasPhysical) {
    empty.add('physicalPrefs')
    empty.add('physicalCompatibility')
  }
  if (!p.loveLangGive?.length && !p.loveLangReceive?.length) empty.add('loveLanguages')
  return empty
}

// Revealed scores for this browser session. Module-level rather than component
// state: the block remounts per profile, and "Maybe" can bring a profile back.
const revealedScores = new Map<string, CompatibilityResult>()

type Status = 'hidden' | 'loading' | 'revealed' | 'error'

export default function CompatibilityBlock({
  profile,
  mode,
  autoReveal = false,
  fullReport = false,
}: {
  profile: DiscoverProfile
  mode: Mode
  // Sparks: the score was already earned, so it loads and shows without a click.
  autoReveal?: boolean
  // Why you match, Things in common, Worth a conversation and the love
  // languages grid. Discover only teases (score, archetype, bars); the full
  // report is the reward in Sparks.
  fullReport?: boolean
}) {
  const targetUid = profile.uid
  const cached = revealedScores.get(targetUid)
  const [status, setStatus] = useState<Status>(cached ? 'revealed' : autoReveal ? 'loading' : 'hidden')
  const [result, setResult] = useState<CompatibilityResult | null>(cached ?? null)
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [me, setMe] = useState<{ uid: string; profile: DiscoverProfile } | null>(null)

  // The side-by-side sections compare Spark data, so they're Spark-only.
  const showComparison = fullReport && status === 'revealed' && mode === 'spark' && uid !== ''
  useEffect(() => {
    if (!showComparison) return
    let cancelled = false
    fetchMyProfile(uid)
      .then((profile) => {
        if (!cancelled && profile) setMe({ uid, profile })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [showComparison, uid])

  useEffect(() => {
    if (autoReveal && !revealedScores.has(targetUid)) void reveal()
    // reveal only reads targetUid, so this runs once per profile.
  }, [autoReveal, targetUid])

  // In Discover the score stays hidden until the user clicks to reveal it.
  async function reveal() {
    setStatus('loading')
    try {
      const data = await fetchCompatibility(targetUid)
      revealedScores.set(targetUid, data)
      setResult(data)
      setStatus('revealed')
    } catch {
      setStatus('error')
    }
  }

  if (status === 'revealed' && result) {
    const comparison =
      showComparison && me?.uid === uid ? <ProfileComparison me={me.profile} them={profile} /> : null
    return (
      <RevealedScore
        result={result}
        mode={mode}
        animate={!cached}
        hidden={emptyCategories(profile)}
        fullReport={fullReport}
        comparison={comparison}
      />
    )
  }

  return (
    <div className="mt-4">
      <div className="relative flex h-24 max-w-xs items-center overflow-hidden rounded-xl">
        <span className="select-none pl-4 text-5xl font-bold text-white/30" aria-hidden>
          ✦
        </span>
        <div className="absolute inset-0 flex items-center justify-center bg-white/5 backdrop-blur-md">
          {status === 'loading' ? (
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          ) : (
            <button
              type="button"
              onClick={reveal}
              className="cursor-pointer rounded-full border border-white/20 bg-white/5 px-5 py-2 text-sm font-medium text-white/70 transition-all hover:border-white/40 hover:bg-white/10 hover:text-white"
            >
              {status === 'error' ? 'Try again ✦' : 'Reveal your score ✦'}
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 max-w-xs text-center text-xs text-white/30">
        {status === 'error'
          ? "Couldn't load your score."
          : status === 'loading' && autoReveal
            ? 'Loading your compatibility…'
            : 'See how compatible you really are'}
      </p>
    </div>
  )
}

function RevealedScore({
  result,
  mode,
  animate,
  hidden,
  fullReport,
  comparison,
}: {
  result: CompatibilityResult
  mode: Mode
  animate: boolean
  hidden: Set<string>
  fullReport: boolean
  comparison: ReactNode
}) {
  const theme = discoverTheme(mode)
  // Start hidden only when freshly revealed, then fade/slide in on the next frame.
  const [visible, setVisible] = useState(!animate)
  useEffect(() => {
    if (!animate) return
    const frame = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [animate])

  const score = mode === 'play' ? result.playScore : result.sparkScore
  if (typeof score !== 'number') {
    return <p className="mt-4 text-sm text-white/40">No compatibility score available yet.</p>
  }

  const breakdown = mode === 'play' ? result.breakdown?.play : result.breakdown?.spark
  const withValue = (c: { key: string; label: string }) => ({ ...c, value: hidden.has(c.key) ? undefined : breakdown?.[c.key] })
  const hasValue = (c: { key: string; label: string; value?: number }): c is { key: string; label: string; value: number } =>
    typeof c.value === 'number'
  const bars = CATEGORIES[mode].map(withValue).filter(hasValue)
  const insights = fullReport
    ? ALL_CATEGORIES[mode]
        .map(withValue)
        .filter(hasValue)
        .filter((c) => c.value > INSIGHT_THRESHOLD)
    : []
  const dealbreakers = result.triggeredDealbreakers ?? []
  // tier1 is computed from Spark data only, so it never shows in Play mode.
  const tier1 = mode === 'spark' ? (result.tier1 ?? null) : null
  const archetype = tier1?.archetype && tier1.archetype.confidence > 0.4 ? tier1.archetype : null
  const deepFit =
    tier1 && tier1.combinedScore !== null && (tier1.dataConfidence ?? 0) > 0
      ? Math.min(100, Math.round(tier1.combinedScore))
      : null
  const rounded = Math.round(score)
  const qualifier = scoreQualifier(rounded)

  return (
    <div
      className={`mt-4 transition-all duration-500 ${visible ? 'translate-y-0 opacity-100 blur-0' : 'translate-y-1 opacity-0 blur-sm'}`}
    >
      {archetype && (
        <div className="mb-4 rounded-xl border border-white/[0.08] bg-white/5 p-4">
          <p className="text-sm font-semibold text-[#1B4FD8]">✦ {archetype.label}</p>
          {archetype.copy && <p className="mt-1 text-sm text-white/60">{archetype.copy}</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <p className={`text-5xl font-bold ${scoreColor(rounded)}`}>{rounded}%</p>
        {deepFit !== null && (
          <span className="rounded-full bg-[#1B4FD8]/20 px-3 py-1 text-xs text-[#1B4FD8]">✦ Deep Fit {deepFit}%</span>
        )}
      </div>
      <p className="mt-1 text-xs uppercase tracking-widest text-white/30">{mode === 'play' ? 'Play Odds' : 'Spark Odds'}</p>
      {qualifier && <p className="mt-0.5 text-xs text-white/50">{qualifier}</p>}

      {bars.length > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          {bars.map((b) => (
            <div key={b.key}>
              <p className="mb-1.5 text-xs font-medium text-white/60">{b.label}</p>
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${theme.barFill}`}
                  style={{ width: visible ? `${Math.min(100, Math.max(0, b.value))}%` : '0%' }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {insights.length > 0 && (
        <div className="mt-6">
          <p className="text-[11px] uppercase tracking-widest text-white font-semibold mb-4">Why you match</p>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {insights.map((c) => (
              <li key={c.key} className="text-sm">
                <span className="text-white/55">{c.label}</span>
                <span className="mx-2 text-white/20">·</span>
                <span className="text-white/80">{categoryInsight(c.key, c.value, tier1?.asymmetryGap ?? null)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {comparison}

      {dealbreakers.length > 0 && (
        <div className="mt-5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-400">
            You flagged a dealbreaker — {dealbreakerLabel(dealbreakers[0])} — this is your call to make.
          </p>
        </div>
      )}
    </div>
  )
}
