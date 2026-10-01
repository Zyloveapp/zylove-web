import type { SparkEntry } from '../../services/sparks'
import { displayAge } from '../../services/discover'
import { relativeTime } from '../../services/matches'

interface SparksListProps {
  sparks: SparkEntry[]
  // Likers you've already matched with — their photo and name are revealed.
  matchedUids: Set<string>
  onSelect: (spark: SparkEntry) => void
}

function expiresIn(expiresAt: number): string {
  const ms = expiresAt - Date.now()
  const hours = Math.floor(ms / 3_600_000)
  return hours >= 1 ? `Expires in ${hours}h` : `Expires in ${Math.max(1, Math.floor(ms / 60_000))}m`
}

export default function SparksList({ sparks, matchedUids, onSelect }: SparksListProps) {
  if (sparks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
        <p className="text-xl font-semibold text-white">✦ No sparks yet</p>
        <p className="mt-2 max-w-xs text-sm text-white/50">People who are interested in you will appear here</p>
      </div>
    )
  }

  return (
    <ul>
      {sparks.map((s) => {
        const matched = matchedUids.has(s.likerUid)
        // Name and age show for matched people and bots; photos are always clear.
        const revealed = matched || s.isBot
        const photo = s.profile.photoURLs?.[0]
        const age = displayAge(s.profile)
        const subtitle = matched ? "You're matched" : 'Tap to see their profile'
        return (
          <li key={s.likerUid}>
            <button
              type="button"
              onClick={() => onSelect(s)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5"
            >
              <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full bg-gradient-to-br from-[#1B4FD8]/60 to-white/10">
                {photo && (
                  <img src={photo} alt="" className="h-full w-full object-cover" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium text-white/90">
                    {revealed ? (
                      <>
                        {s.profile.displayName ?? 'Someone'}
                        {age !== null && <span className="font-normal text-white/50">, {age}</span>}
                      </>
                    ) : s.isWeeklySpark ? (
                      <span className="text-[#F59E0B]">✦ Weekly Spark</span>
                    ) : (
                      'Your compatibility report is ready ✦'
                    )}
                  </span>
                  {s.likedAt > 0 && <span className="shrink-0 text-xs text-white/35">{relativeTime(s.likedAt)}</span>}
                </span>
                {revealed && s.isWeeklySpark && <span className="block text-xs text-[#F59E0B]">✦ Weekly Spark</span>}
                <span className="block truncate text-sm text-white/40">{subtitle}</span>
                {s.expiresAt !== null && <span className="block text-xs text-amber-400">{expiresIn(s.expiresAt)}</span>}
              </span>
              {s.compatibilityScore !== null && (
                <span className="shrink-0 text-center">
                  <span className="block text-2xl font-bold leading-none text-[#1B4FD8]">
                    {Math.round(s.compatibilityScore)}%
                  </span>
                  <span className="mt-1 block text-[10px] uppercase tracking-widest text-white/30">match</span>
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
