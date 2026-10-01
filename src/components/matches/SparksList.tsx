import type { SparkEntry } from '../../services/sparks'
import { displayAge } from '../../services/discover'
import { relativeTime } from '../../services/matches'

interface SparksListProps {
  sparks: SparkEntry[]
  // Likers you've already matched with — their photo and name are revealed.
  matchedUids: Set<string>
  onSelect: (spark: SparkEntry) => void
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
        const photo = s.profile.photoURLs?.[0]
        const age = displayAge(s.profile)
        return (
          <li key={s.likerUid}>
            <button
              type="button"
              onClick={() => onSelect(s)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5"
            >
              <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full bg-gradient-to-br from-[#1B4FD8]/60 to-white/10">
                {photo && (
                  <img
                    src={photo}
                    alt=""
                    className={`h-full w-full object-cover ${matched ? '' : 'scale-125 blur-md'}`}
                  />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium text-white/90">
                    {matched ? (
                      <>
                        {s.profile.displayName ?? 'Someone'}
                        {age !== null && <span className="font-normal text-white/50">, {age}</span>}
                      </>
                    ) : (
                      'Someone likes you ✦'
                    )}
                  </span>
                  {s.likedAt > 0 && <span className="shrink-0 text-xs text-white/35">{relativeTime(s.likedAt)}</span>}
                </span>
                <span className="block truncate text-sm text-white/40">
                  {matched ? "You're matched" : 'Tap to see their profile'}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
