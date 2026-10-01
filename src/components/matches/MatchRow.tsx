import { relativeTime, type MatchEntry } from '../../services/matches'
import { UserTierBadge } from '../TierBadge'

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

interface MatchRowProps {
  match: MatchEntry
  unread: boolean
  active: boolean
  onSelect: () => void
}

export default function MatchRow({ match, unread, active, onSelect }: MatchRowProps) {
  const time = relativeTime(match.lastMessageAt || match.matchedAt)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active}
      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] ${
        active ? 'bg-white/5' : ''
      }`}
    >
      <span className="flex w-2 shrink-0 justify-center">
        {unread && <span className="h-2 w-2 rounded-full bg-[#1B4FD8]" aria-label="Unread" />}
      </span>

      {match.photoURL ? (
        <img src={match.photoURL} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white/70">
          {initials(match.name)}
        </span>
      )}

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className={`truncate ${unread ? 'font-semibold text-white' : 'font-medium text-white/90'}`}>
              {match.name}
              {match.age !== null && <span className="font-normal text-white/50">, {match.age}</span>}
            </span>
            <UserTierBadge uid={match.partnerUid} />
          </span>
          {time && <span className="shrink-0 text-xs text-white/35">{time}</span>}
        </span>
        <span className={`block truncate text-sm ${unread ? 'text-white/80' : 'text-white/40'}`}>
          {match.lastMessagePreview || match.lastMessageAt > 0 ? 'New message' : 'Say hello 👋'}
        </span>
      </span>
    </button>
  )
}
