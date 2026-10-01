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
  // Anywhere on the row: open the chat.
  onSelect: () => void
  // Avatar or name: open their profile.
  onOpenProfile: () => void
}

// The whole row opens the chat (a full-size button underneath); the avatar
// and name sit above it as their own buttons for the profile.
export default function MatchRow({ match, unread, active, onSelect, onOpenProfile }: MatchRowProps) {
  const time = relativeTime(match.lastMessageAt || match.matchedAt)
  return (
    <div className={`relative flex w-full items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03] ${active ? 'bg-white/5' : ''}`}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active}
        aria-label={`Open chat with ${match.name}`}
        className="absolute inset-0"
      />

      <span className="pointer-events-none flex w-2 shrink-0 justify-center">
        {unread && <span className="h-2 w-2 rounded-full bg-[#1B4FD8]" aria-label="Unread" />}
      </span>

      <button
        type="button"
        onClick={onOpenProfile}
        aria-label={`View ${match.name}'s profile`}
        className="relative shrink-0 rounded-full"
      >
        {match.photoURL ? (
          <img src={match.photoURL} alt="" className="h-12 w-12 rounded-full object-cover" />
        ) : (
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white/70">
            {initials(match.name)}
          </span>
        )}
      </button>

      <span className="pointer-events-none min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={onOpenProfile}
              className={`pointer-events-auto relative truncate text-left hover:underline ${
                unread ? 'font-semibold text-white' : 'font-medium text-white/90'
              }`}
            >
              {match.name}
              {match.age !== null && <span className="font-normal text-white/50">, {match.age}</span>}
            </button>
            <UserTierBadge uid={match.partnerUid} />
          </span>
          {time && <span className="shrink-0 text-xs text-white/35">{time}</span>}
        </span>
        <span className={`block truncate text-sm ${unread ? 'text-white/80' : 'text-white/40'}`}>
          {match.lastMessagePreview || match.lastMessageAt > 0 ? 'New message' : 'Say hello 👋'}
        </span>
      </span>
    </div>
  )
}
