import type { ReactNode } from 'react'
import { CURIOUS_MAX, type CuriousResult, type SentSpark, type SparkEntry } from '../../services/sparks'
import { displayAge, type DiscoverProfile, type TopPick } from '../../services/discover'
import { UserTierBadge } from '../TierBadge'
import { relativeTime } from '../../services/matches'
import type { Mode } from '../../store/modeStore'

function expiresIn(expiresAt: number): string {
  const ms = expiresAt - Date.now()
  const hours = Math.floor(ms / 3_600_000)
  return hours >= 1 ? `Expires in ${hours}h` : `Expires in ${Math.max(1, Math.floor(ms / 60_000))}m`
}

const INTENT_PILL: Record<string, string> = {
  spark: 'Here for something real',
  play: 'Here for a good time',
  open: 'Open to connection',
}

function IntentPill({ intent }: { intent: unknown }) {
  const label = typeof intent === 'string' ? INTENT_PILL[intent] : undefined
  if (!label) return null
  return (
    <span className="inline-block rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-white/70">
      {label}
    </span>
  )
}

function ScorePill({ score, mode }: { score: number; mode: Mode }) {
  const tone = mode === 'play' ? 'border-[#E03131]/40 bg-[#E03131]/15 text-red-300' : 'border-[#1B4FD8]/40 bg-[#1B4FD8]/15 text-[#9DB4FF]'
  return <span className={`shrink-0 rounded-full border px-2.5 py-1 text-sm font-bold ${tone}`}>{Math.round(score)}%</span>
}

// Full-width card shared by every Sparks tab: large photo left, details right.
function Card({
  photo,
  onSelect,
  children,
  score,
}: {
  photo: string | undefined
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
        <span className="relative h-36 w-28 shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-[#1B4FD8]/60 to-white/10">
          {photo && <img src={photo} alt="" className="h-full w-full object-cover" />}
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

function NameLine({ profile, uid }: { profile: DiscoverProfile; uid: string }) {
  const age = displayAge(profile)
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate text-lg font-semibold text-white">
        {profile.displayName ?? 'Someone'}
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
  // Real scores (likerUid → %) for cards whose profile has been opened; they
  // replace the like's snapshot score, which is random for bots.
  scores?: Map<string, number>
}

export default function SparksList({ sparks, mode, matchedUids, onSelect, scores }: SparksListProps) {
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
      {sparks.map((s) => {
        const matched = matchedUids.has(s.likerUid)
        // Name, age and place show for matched people and bots; photos are always clear.
        const revealed = matched || s.isBot
        return (
          <Card
            key={s.likerUid}
            photo={s.profile.photoURLs?.[0]}
            onSelect={() => onSelect(s)}
            score={(() => {
              const value = scores?.get(s.likerUid) ?? s.compatibilityScore
              return value !== null ? <ScorePill score={value} mode={mode} /> : null
            })()}
          >
            {s.isWeeklySpark && <span className="block text-xs font-semibold text-[#F59E0B]">✦ Weekly Spark</span>}
            {revealed ? (
              <NameLine profile={s.profile} uid={s.likerUid} />
            ) : (
              <span className="block text-base font-semibold text-white">Your compatibility report is ready ✦</span>
            )}
            {revealed && s.profile.locationLabel && (
              <span className="mt-0.5 block truncate text-sm text-white/50">📍 {s.profile.locationLabel}</span>
            )}
            <span className="mt-2 flex flex-wrap items-center gap-2">
              <IntentPill intent={s.profile.intent} />
              {matched && <span className="text-[11px] text-emerald-300">You're linked</span>}
            </span>
            <span className="mt-1 block text-xs text-white/35">
              {s.likedAt > 0 && relativeTime(s.likedAt)}
              {s.expiresAt !== null && <span className="ml-2 text-amber-400">{expiresIn(s.expiresAt)}</span>}
            </span>
          </Card>
        )
      })}
    </ul>
  )
}

export function TopPicksList({ picks, mode, onSelect }: { picks: TopPick[]; mode: Mode; onSelect: (pick: TopPick) => void }) {
  if (picks.length === 0) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-sm text-white/50">
          Top Picks come from profiles you've opened in Explore. Keep exploring and your best matches will land here.
        </p>
      </div>
    )
  }
  return (
    <ul className="space-y-3">
      {picks.map((p) => (
        <Card
          key={p.profile.uid}
          photo={p.profile.photoURLs?.[0]}
          onSelect={() => onSelect(p)}
          score={<ScorePill score={p.score.value} mode={mode} />}
        >
          <span className="block text-xs font-semibold text-[#F59E0B]">✦ Top Pick</span>
          <NameLine profile={p.profile} uid={p.profile.uid} />
          {p.profile.locationLabel && (
            <span className="mt-0.5 block truncate text-sm text-white/50">📍 {p.profile.locationLabel}</span>
          )}
          <span className="mt-2 block">
            <IntentPill intent={p.profile.intent} />
          </span>
        </Card>
      ))}
    </ul>
  )
}

// Outgoing likes still waiting on the other person. No "Tap for full
// breakdown" target yet, so these cards aren't buttons.
export function SentList({ sent, mode }: { sent: SentSpark[]; mode: Mode }) {
  if (sent.length === 0) {
    return <p className="px-6 py-16 text-center text-sm text-white/50">No pending sparks. Keep exploring ✦</p>
  }
  return (
    <ul className="space-y-3">
      {sent.map((s) => (
        <li key={s.uid} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
          <span className="relative h-24 w-20 shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-[#1B4FD8]/60 to-white/10">
            {s.photoURL && <img src={s.photoURL} alt="" className="h-full w-full object-cover" />}
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
  if (result.count === 0) {
    return (
      <p className="px-6 py-16 text-center text-sm text-white/50">
        ✦ No one has revealed their score with you yet. Keep exploring.
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
            <span key={i} className="h-full flex-1 rounded-xl bg-gradient-to-br from-[#1B4FD8]/50 to-white/10" />
          ))}
        </div>
        <div className="relative">
          <p className="text-xl font-bold text-white">
            ✦ {count} {result.count === 1 ? 'person is' : 'people are'} curious about you
          </p>
          <p className="mt-2 text-sm text-white/60">See who revealed your compatibility.</p>
          <span className="mt-5 inline-block rounded-full bg-[#F59E0B] px-5 py-2 text-sm font-semibold text-gray-950">
            Unlock with Elite
          </span>
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
          onSelect={() => onSelect(v.uid)}
          score={v.score ? <ScorePill score={v.score.value} mode={mode} /> : null}
        >
          <span className="block text-xs font-semibold text-[#9DB4FF]">Revealed your compatibility ✦</span>
          <NameLine profile={v.profile} uid={v.uid} />
          {v.profile.locationLabel && (
            <span className="mt-0.5 block truncate text-sm text-white/50">📍 {v.profile.locationLabel}</span>
          )}
          <span className="mt-2 block">
            <IntentPill intent={v.profile.intent} />
          </span>
        </Card>
      ))}
    </ul>
  )
}
