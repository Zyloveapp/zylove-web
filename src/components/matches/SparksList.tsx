import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CURIOUS_MAX, type CuriousResult, type SentSpark, type SparkEntry } from '../../services/sparks'
import { displayAge, type DiscoverProfile } from '../../services/discover'
import { UserTierBadge } from '../TierBadge'
import { UserFounderBadge } from '../FounderBadge'
import DistanceLabel from '../DistanceLabel'
import { relativeTime } from '../../services/matches'
import type { Mode } from '../../store/modeStore'
import { playNameOf } from '../../services/displayNames'
import { usePlayIdentity } from './usePlayIdentity'
import StoredImg from '../StoredImg'

function expiresIn(expiresAt: number): string {
  const ms = expiresAt - Date.now()
  const hours = Math.floor(ms / 3_600_000)
  return hours >= 1 ? `Expires in ${hours}h` : `Expires in ${Math.max(1, Math.floor(ms / 60_000))}m`
}

// null score: still being calculated (a neutral placeholder).
function ScorePill({ score, mode }: { score: number | null; mode: Mode }) {
  const tone = mode === 'play' ? 'border-[#E03131]/40 bg-[#E03131]/15 text-red-300' : 'border-[#1B4FD8]/40 bg-[#1B4FD8]/15 text-[#9DB4FF]'
  if (score === null) {
    return (
      <span className={`shrink-0 animate-pulse rounded-full border px-2.5 py-1 text-sm font-bold ${tone}`} aria-label="Score loading">
        –%
      </span>
    )
  }
  return <span className={`shrink-0 rounded-full border px-2.5 py-1 text-sm font-bold ${tone}`}>{Math.round(score)}%</span>
}

// Photo placeholder tint per mode.
function placeholderTint(mode: Mode): string {
  return mode === 'play' ? 'from-[#E03131]/60' : 'from-[#1B4FD8]/60'
}

// Full-width card shared by every Sparks tab: large photo left, details right.
function Card({
  photo,
  mode,
  onSelect,
  children,
  score,
}: {
  photo: string | null | undefined
  mode: Mode
  onSelect: () => void
  children: ReactNode
  score: ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-stretch gap-4 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-left transition-colors hover:bg-white/[0.07]"
      >
        <span className={`relative h-36 w-28 shrink-0 overflow-hidden rounded-xl bg-gradient-to-br to-white/10 ${placeholderTint(mode)}`}>
          {photo && <StoredImg src={photo} alt="" className="h-full w-full object-cover" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-between py-1">
          <span className="min-w-0">{children}</span>
          <span className="flex items-end justify-between gap-2">
            <span className="text-xs text-white/40">Tap for full breakdown →</span>
            {score}
          </span>
        </span>
      </button>
    </li>
  )
}

function NameLine({ profile, uid, mode, name: known }: { profile: DiscoverProfile; uid: string; mode: Mode; name?: string }) {
  const age = displayAge(profile)
  const name = known || (mode === 'play' ? playNameOf(profile, profile.playProfile) : profile.displayName)
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate text-lg font-semibold text-white">
        {name || 'Someone'}
        {age !== null && <span className="font-normal text-white/50">, {age}</span>}
      </span>
      <UserTierBadge uid={uid} />
    </span>
  )
}

interface SparksListProps {
  sparks: SparkEntry[]
  mode: Mode
  // Likers you've already matched with — their name is revealed.
  matchedUids: Set<string>
  onSelect: (spark: SparkEntry) => void
  // Real scores (likerUid → %) from onTap: cards whose profile has been
  // opened, and every bot (whose like carries no trustworthy score).
  scores?: Map<string, number>
  // Top Picks tab: adds the gold "✦ Top Pick" label to every card.
  topPicks?: boolean
}

export default function SparksList({ sparks, mode, matchedUids, onSelect, scores, topPicks = false }: SparksListProps) {
  if (sparks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
        <p className="text-xl font-semibold text-white">{mode === 'play' ? '🔥 No flames yet' : '✦ No sparks yet'}</p>
        <p className="mt-2 max-w-xs text-sm text-white/50">People who are interested in you will appear here</p>
      </div>
    )
  }

  return (
    <ul className="space-y-3">
      {sparks.map((s) => (
        <SparkCard
          key={s.likerUid}
          spark={s}
          mode={mode}
          matched={matchedUids.has(s.likerUid)}
          score={scores?.get(s.likerUid) ?? s.compatibilityScore}
          onSelect={() => onSelect(s)}
          topPick={topPicks}
        />
      ))}
    </ul>
  )
}

function SparkCard({
  spark: s,
  mode,
  matched,
  score,
  onSelect,
  topPick,
}: {
  spark: SparkEntry
  mode: Mode
  matched: boolean
  score: number | null
  onSelect: () => void
  topPick: boolean
}) {
  const symbol = mode === 'play' ? '🔥' : '✦'
  // Like snapshots carry the Spark photo and name; Play shows the Play ones.
  const identity = usePlayIdentity(s.likerUid, mode === 'play')
  const photo = identity === null ? s.profile.photoURLs?.[0] : identity?.photoURL
  // Name, age and place show only once you're linked — curated profiles
  // included; photos are always clear.
  const revealed = matched
  return (
    <Card
      photo={photo}
      mode={mode}
      onSelect={onSelect}
      // Bots' scores arrive from onTap; until then a placeholder.
      score={score !== null ? <ScorePill score={score} mode={mode} /> : s.isBot ? <ScorePill score={null} mode={mode} /> : null}
    >
      {topPick && <span className="block text-xs font-semibold text-[#F59E0B]">{symbol} Top Pick</span>}
      {s.isWeeklySpark && <span className="block text-xs font-semibold text-[#F59E0B]">✦ Weekly Spark</span>}
      {revealed ? (
        <NameLine profile={s.profile} uid={s.likerUid} mode={mode} name={identity?.name} />
      ) : (
        <span className="block text-base font-semibold text-white">Your compatibility report is ready {symbol}</span>
      )}
      {revealed && (
        <DistanceLabel profile={{ ...s.profile, uid: s.likerUid }} className="mt-0.5 block truncate text-sm text-white/50" />
      )}
      {revealed && <UserFounderBadge uid={s.likerUid} />}
      {matched && <span className="mt-2 block text-[11px] text-emerald-300">You're linked</span>}
      <span className="mt-1 block text-xs text-white/35">
        {s.likedAt > 0 && relativeTime(s.likedAt)}
        {s.expiresAt !== null && <span className="ml-2 text-amber-400">{expiresIn(s.expiresAt)}</span>}
      </span>
    </Card>
  )
}

// Outgoing likes still waiting on the other person. No "Tap for full
// breakdown" target yet, so these cards aren't buttons.
export function SentList({ sent, mode }: { sent: SentSpark[]; mode: Mode }) {
  if (sent.length === 0) {
    return (
      <p className="px-6 py-16 text-center text-sm text-white/50">
        {mode === 'play' ? 'No pending flames. Keep exploring 🔥' : 'No pending sparks. Keep exploring ✦'}
      </p>
    )
  }
  return (
    <ul className="space-y-3">
      {sent.map((s) => (
        <li key={s.uid} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
          <span className={`relative h-24 w-20 shrink-0 overflow-hidden rounded-xl bg-gradient-to-br to-white/10 ${placeholderTint(mode)}`}>
            {s.photoURL && <StoredImg src={s.photoURL} alt="" className="h-full w-full object-cover" />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-lg font-semibold text-white">
                {s.name}
                {s.age !== null && <span className="font-normal text-white/50">, {s.age}</span>}
              </span>
              <UserTierBadge uid={s.uid} />
            </span>
            <span className="flex items-center gap-2 text-sm text-white/45">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/40" aria-hidden />
              Waiting...
            </span>
            {s.likedAt > 0 && <span className="text-xs text-white/30">Sent {relativeTime(s.likedAt)}</span>}
          </span>
          {s.score && <ScorePill score={s.score.value} mode={mode} />}
        </li>
      ))}
    </ul>
  )
}

// People who opened your score first. Locked tiers see only the count.
export function CuriousList({
  result,
  mode,
  onSelect,
}: {
  result: CuriousResult
  mode: Mode
  onSelect: (uid: string) => void
}) {
  const play = mode === 'play'
  const symbol = play ? '🔥' : '✦'
  if (result.count === 0) {
    return (
      <p className="px-6 py-16 text-center text-sm text-white/50">
        {symbol} No one has revealed their score with you yet. Keep exploring.
      </p>
    )
  }
  if (result.locked) {
    const count = result.count >= CURIOUS_MAX ? `${CURIOUS_MAX}+` : String(result.count)
    return (
      <div className="relative overflow-hidden rounded-2xl border border-[#F59E0B]/30 bg-white/[0.04] p-6 text-center">
        {/* Decorative blurred cards; no real names or photos are sent to locked tiers. */}
        <div className="pointer-events-none absolute inset-0 flex gap-3 p-3 opacity-40 blur-md" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`h-full flex-1 rounded-xl bg-gradient-to-br to-white/10 ${play ? 'from-[#E03131]/50' : 'from-[#1B4FD8]/50'}`}
            />
          ))}
        </div>
        <div className="relative">
          <p className="text-xl font-bold text-white">
            {symbol} {count} {result.count === 1 ? 'person is' : 'people are'} curious about you
          </p>
          <p className="mt-2 text-sm text-white/60">See who revealed your compatibility.</p>
          <Link
            to="/upgrade"
            className="mt-5 inline-block rounded-full bg-[#F59E0B] px-5 py-2 text-sm font-semibold text-gray-950 transition-opacity hover:opacity-90"
          >
            Unlock with Elite
          </Link>
        </div>
      </div>
    )
  }
  return (
    <ul className="space-y-3">
      {result.visitors.map((v) => (
        <Card
          key={v.uid}
          photo={v.profile.photoURLs?.[0]}
          mode={mode}
          onSelect={() => onSelect(v.uid)}
          score={v.score ? <ScorePill score={v.score.value} mode={mode} /> : null}
        >
          <span className={`block text-xs font-semibold ${play ? 'text-red-300' : 'text-[#9DB4FF]'}`}>
            Revealed your compatibility {symbol}
          </span>
          <NameLine profile={v.profile} uid={v.uid} mode={mode} />
          <DistanceLabel profile={{ ...v.profile, uid: v.uid }} className="mt-0.5 block truncate text-sm text-white/50" />
        </Card>
      ))}
    </ul>
  )
}
