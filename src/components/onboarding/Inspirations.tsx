import { useState } from 'react'

// Short starter phrases from the prompt banks (AppPrompt.inspirations).
// Tapping one fills the answer, which the user can then edit.

type Mode = 'spark' | 'play'

const TOGGLE_LABEL: Record<Mode, string> = { spark: '✦ Need a spark?', play: '🔥 Need a spark?' }
const HIDE_LABEL: Record<Mode, string> = { spark: '✦ Hide', play: '🔥 Hide' }
const ROW_TINT: Record<Mode, string> = { spark: 'bg-[#1B4FD8]/[0.08] hover:bg-[#1B4FD8]/15', play: 'bg-[#E03131]/[0.08] hover:bg-[#E03131]/15' }
const PILL_CLASS: Record<Mode, string> = { spark: 'bg-[#1B4FD8]/10 text-blue-300', play: 'bg-[#E03131]/10 text-red-300' }

// Onboarding: hidden behind a "Need a spark?" toggle.
export function InspirationToggle({ mode, inspirations, onPick }: { mode: Mode; inspirations?: string[]; onPick: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  if (!inspirations?.length) return null
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border border-white/15 px-3 py-1 text-sm text-white/50 hover:text-white/80"
      >
        {open ? HIDE_LABEL[mode] : TOGGLE_LABEL[mode]}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {inspirations.map((ins) => (
            <button
              key={ins}
              type="button"
              onClick={() => {
                onPick(ins)
                setOpen(false)
              }}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm text-white/80 ${ROW_TINT[mode]}`}
            >
              "{ins}"
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Profile edit: shown automatically while the answer is empty.
export function InspirationPills({ mode, inspirations, answer, onPick }: { mode: Mode; inspirations?: string[]; answer: string; onPick: (text: string) => void }) {
  if (!inspirations?.length || answer.length > 0) return null
  return (
    <div className="mt-2">
      <p className="mb-1.5 text-xs text-white/50">Tap to use, then edit:</p>
      <div className="flex flex-wrap gap-2">
        {inspirations.map((ins) => (
          <button key={ins} type="button" onClick={() => onPick(ins)} className={`rounded-full px-3 py-1 text-left text-sm ${PILL_CLASS[mode]}`}>
            {ins}
          </button>
        ))}
      </div>
    </div>
  )
}
