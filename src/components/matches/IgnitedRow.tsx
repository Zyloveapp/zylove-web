import type { MatchEntry } from '../../services/matches'
import type { Mode } from '../../store/modeStore'

interface IgnitedRowProps {
  title: string
  matches: MatchEntry[]
  mode: Mode
  activeId: string | null
  onSelect: (m: MatchEntry) => void
}

// New links nobody has written to yet ("The spark is lit" / "Entangled").
export default function IgnitedRow({ title, matches, mode, activeId, onSelect }: IgnitedRowProps) {
  const ring = mode === 'play' ? 'ring-[#E03131]' : 'ring-[#1B4FD8]'
  return (
    <section className="pb-2">
      <h2 className="px-4 text-sm font-semibold text-white/70">
        {title} <span className="text-white/40">· {matches.length}</span>
      </h2>
      <ul className="flex gap-4 overflow-x-auto px-4 pt-3 pb-2 [scrollbar-width:none]">
        {matches.map((m) => (
          <li key={m.matchId} className="shrink-0">
            <button
              type="button"
              onClick={() => onSelect(m)}
              aria-current={m.matchId === activeId}
              className="flex w-16 flex-col items-center gap-1.5"
            >
              {m.photoURL ? (
                <img
                  src={m.photoURL}
                  alt=""
                  className={`h-14 w-14 rounded-full object-cover ring-2 ring-offset-2 ring-offset-gray-950 ${ring}`}
                />
              ) : (
                <span
                  className={`flex h-14 w-14 items-center justify-center rounded-full bg-white/10 font-semibold text-white/70 ring-2 ring-offset-2 ring-offset-gray-950 ${ring}`}
                >
                  {m.name.charAt(0).toUpperCase()}
                </span>
              )}
              <span className="w-full truncate text-center text-xs text-white/60">{m.name.split(/\s+/)[0]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
