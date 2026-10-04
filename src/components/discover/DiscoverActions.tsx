import type { Mode } from '../../store/modeStore'

export type DiscoverAction = 'interested' | 'maybe' | 'pass'

interface DiscoverActionsProps {
  mode: Mode
  busy: boolean
  error: string | null
  onAction: (action: DiscoverAction) => void
  // One row (Not Interested · Maybe · I'm Interested), for the mobile
  // sticky bar.
  compact?: boolean
}

export default function DiscoverActions({ mode, busy, error, onAction, compact = false }: DiscoverActionsProps) {
  const primary =
    mode === 'play' ? 'bg-[#E03131] hover:bg-[#E03131]/90' : 'bg-[#1B4FD8] hover:bg-[#1B4FD8]/90'

  if (compact) {
    return (
      <div className={busy ? 'opacity-50' : ''}>
        {error && <p className="mb-2 text-center text-sm text-red-400">{error}</p>}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onAction('pass')}
            disabled={busy}
            className="shrink-0 px-2 py-3 text-sm text-white/40 transition-colors hover:text-white/60 disabled:cursor-not-allowed"
          >
            Not Interested
          </button>
          <button
            type="button"
            onClick={() => onAction('maybe')}
            disabled={busy}
            className="flex-1 rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-medium text-white/70 transition-all hover:bg-white/10 disabled:cursor-not-allowed"
          >
            Maybe
          </button>
          <button
            type="button"
            onClick={() => onAction('interested')}
            disabled={busy}
            className={`flex-[2] rounded-xl py-3 text-sm font-semibold tracking-wide text-white transition-all disabled:cursor-not-allowed ${primary}`}
          >
            I'm Interested
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex flex-col gap-3 ${busy ? 'opacity-50' : ''}`}>
      <button
        type="button"
        onClick={() => onAction('interested')}
        disabled={busy}
        className={`w-full rounded-xl py-4 text-base font-semibold tracking-wide text-white transition-all disabled:cursor-not-allowed ${primary}`}
      >
        I'm Interested
      </button>
      <button
        type="button"
        onClick={() => onAction('maybe')}
        disabled={busy}
        className="w-full rounded-xl border border-white/10 bg-white/5 py-4 text-base font-medium text-white/70 transition-all hover:bg-white/10 disabled:cursor-not-allowed"
      >
        Maybe
      </button>
      <button
        type="button"
        onClick={() => onAction('pass')}
        disabled={busy}
        className="w-full cursor-pointer py-3 text-center text-sm text-white/30 transition-colors hover:text-white/50 disabled:cursor-not-allowed"
      >
        Not Interested
      </button>
      {error && <p className="text-center text-sm text-red-400">{error}</p>}
    </div>
  )
}
