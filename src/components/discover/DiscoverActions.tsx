import type { Mode } from '../../store/modeStore'

export type DiscoverAction = 'interested' | 'maybe' | 'pass'

interface DiscoverActionsProps {
  mode: Mode
  busy: boolean
  error: string | null
  onAction: (action: DiscoverAction) => void
}

export default function DiscoverActions({ mode, busy, error, onAction }: DiscoverActionsProps) {
  const primary =
    mode === 'play' ? 'bg-[#E03131] hover:bg-[#E03131]/90' : 'bg-[#1B4FD8] hover:bg-[#1B4FD8]/90'

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
