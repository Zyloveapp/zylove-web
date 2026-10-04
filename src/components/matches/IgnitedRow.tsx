import type { MatchEntry } from '../../services/matches'
import type { Mode } from '../../store/modeStore'
import { usePlayIdentity } from './usePlayIdentity'

interface IgnitedRowProps {
  // No heading when null (Spark: new links just lead the list).
  title: string | null
  matches: MatchEntry[]
  mode: Mode
  activeId: string | null
  onSelect: (m: MatchEntry) => void
}

// New links nobody has written to yet. Only Play gives the row a heading
// ("🔥 Entanglements"), styled red with a count pill.
export default function IgnitedRow({ title, matches, mode, activeId, onSelect }: IgnitedRowProps) {
  const ring = mode === 'play' ? 'ring-[#E03131]' : 'ring-[#1B4FD8]'
  return (
    <section className="pb-2">
      {title && (
        <h2 className="mx-4 mb-3 flex items-center gap-2 border-b border-[#E03131]/20 pb-2 text-lg font-semibold text-red-400">
          {title}
          <span className="rounded-full bg-[#E03131]/20 px-2 py-0.5 text-sm text-red-400">{matches.length}</span>
        </h2>
      )}
      <ul className={`flex gap-4 overflow-x-auto px-4 pb-2 [scrollbar-width:none] ${title ? '' : 'pt-1'}`}>
        {matches.map((m) => (
          <IgnitedItem key={m.matchId} match={m} ring={ring} active={m.matchId === activeId} onSelect={() => onSelect(m)} />
        ))}
      </ul>
    </section>
  )
}

function IgnitedItem({ match: m, ring, active, onSelect }: { match: MatchEntry; ring: string; active: boolean; onSelect: () => void }) {
  // Play shows the Play name and photo (older snapshots carry Spark's).
  const identity = usePlayIdentity(m.partnerUid, m.mode === 'play')
  const name = identity?.name || m.name
  const photoURL = identity === null ? m.photoURL : (identity?.photoURL ?? null)
  return (
    <li className="shrink-0">
      <button type="button" onClick={onSelect} aria-current={active} className="flex w-16 flex-col items-center gap-1.5">
        {photoURL ? (
          <img
            src={photoURL}
            alt=""
            className={`h-14 w-14 rounded-full object-cover ring-2 ring-offset-2 ring-offset-gray-950 ${ring}`}
          />
        ) : (
          <span
            className={`flex h-14 w-14 items-center justify-center rounded-full bg-white/10 font-semibold text-white/70 ring-2 ring-offset-2 ring-offset-gray-950 ${ring}`}
          >
            {name.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="w-full truncate text-center text-xs text-white/60">{name.split(/\s+/)[0]}</span>
      </button>
    </li>
  )
}
