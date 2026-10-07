import { relativeTime, type MatchEntry } from '../../services/matches'
import CuratedBadge from '../CuratedBadge'
import { UserTierBadge } from '../TierBadge'
import type { ChatPreview } from '../../services/chatPreview'
import { usePlayIdentity } from './usePlayIdentity'
import StoredImg from '../StoredImg'

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
  // The decrypted last message: undefined while loading, null if unreadable.
  preview?: ChatPreview | null
  active: boolean
  // Anywhere on the row: open the chat.
  onSelect: () => void
  // Avatar or name: open their profile.
  onOpenProfile: () => void
}

// The whole row opens the chat (a full-size button underneath); the avatar
// and name sit above it as their own buttons for the profile.
// The line under the name: an empty chat invites the first message; an
// unread one from them says so; otherwise the last message itself.
function previewLine(match: MatchEntry, unread: boolean, preview: ChatPreview | null | undefined): string {
  const started = match.lastMessagePreview !== null || match.lastMessageAt > 0
  if (!started) return match.mode === 'play' ? 'Say something 🔥' : 'Say hello 👋'
  if (unread) return 'New message'
  if (preview === undefined) return ''
  if (preview === null) return 'New message'
  return preview.fromMe ? `You: ${preview.text}` : preview.text
}

export default function MatchRow({ match, unread, preview, active, onSelect, onOpenProfile }: MatchRowProps) {
  const time = relativeTime(match.lastMessageAt || match.matchedAt)
  const play = match.mode === 'play'
  // Play rows show the Play name and photo (older snapshots carry Spark's).
  const identity = usePlayIdentity(match.partnerUid, play)
  // No Play name → 'Someone'; blank while it loads — never the snapshot's.
  // Unavailable (no Play access on their side right now): the match's own
  // Play snapshot, and a neutral note instead of the preview.
  const unavailable = identity?.unavailable === true
  const name = identity === null ? match.name : unavailable ? match.name : identity?.name || (identity ? 'Someone' : '')
  const photoURL = identity === null ? match.photoURL : unavailable ? null : (identity?.photoURL ?? null)
  return (
    <div className={`relative flex w-full items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03] ${active ? 'bg-white/5' : ''}`}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active}
        aria-label={`Open chat with ${name}`}
        className="absolute inset-0"
      />

      <span className="pointer-events-none flex w-2 shrink-0 justify-center">
        {unread && <span className={`h-2 w-2 rounded-full ${play ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'}`} aria-label="Unread" />}
      </span>

      <button
        type="button"
        onClick={onOpenProfile}
        aria-label={`View ${name}'s profile`}
        className="relative shrink-0 rounded-full"
      >
        {photoURL ? (
          <StoredImg src={photoURL} alt="" className="h-12 w-12 rounded-full object-cover" />
        ) : (
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white/70">
            {initials(name)}
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
              {name}
              {match.age !== null && <span className="font-normal text-white/50">, {match.age}</span>}
            </button>
            <UserTierBadge uid={match.partnerUid} />
            <CuratedBadge uid={match.partnerUid} />
          </span>
          {time && <span className="shrink-0 text-xs text-white/35">{time}</span>}
        </span>
        <span className={`block truncate text-sm ${unread ? 'font-medium text-white' : 'text-white/40'}`}>
          {unavailable ? 'Not available right now' : previewLine(match, unread, preview) || '\u00a0'}
        </span>
      </span>
    </div>
  )
}
