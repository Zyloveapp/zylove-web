import { useState } from 'react'
import { EVIDENCE_CONFIRM_COPY, type EvidenceCandidate } from '../../services/evidence'

// T&S Phase 4 — "Add evidence": pick messages (one by one, or a range),
// photos optional, preview exactly what will be sent, then confirm.
export default function EvidencePicker({
  candidates,
  partnerName,
  busy,
  onBack,
  onConfirm,
}: {
  candidates: EvidenceCandidate[]
  partnerName: string
  busy: boolean
  onBack: () => void
  onConfirm: (items: { candidate: EvidenceCandidate; includePhoto: boolean }[]) => void
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [photos, setPhotos] = useState<Set<string>>(new Set())
  const [rangeStart, setRangeStart] = useState<number | null>(null)
  const [rangeMode, setRangeMode] = useState(false)
  const [preview, setPreview] = useState(false)

  function tap(i: number) {
    const id = candidates[i].id
    if (rangeMode) {
      if (rangeStart === null) return setRangeStart(i)
      const [a, b] = rangeStart < i ? [rangeStart, i] : [i, rangeStart]
      setPicked((p) => new Set([...p, ...candidates.slice(a, b + 1).map((c) => c.id)]))
      setRangeStart(null)
      setRangeMode(false)
      return
    }
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const chosen = candidates.filter((c) => picked.has(c.id) && (c.type === 'text' || photos.has(c.id)))
  const who = (c: EvidenceCandidate) => (c.from === 'me' ? 'You' : partnerName)

  if (preview) {
    return (
      <div>
        <h3 className="text-sm font-semibold text-white/80">This is what will be sent</h3>
        <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto rounded-xl border border-white/10 p-3 text-sm">
          {chosen.map((c) => (
            <li key={c.id}>
              <span className="text-xs text-white/40">{who(c)}</span>
              <p className="whitespace-pre-wrap break-words text-white/85">{c.type === 'photo' ? '📷 Photo' : c.text}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs text-white/70">{EVIDENCE_CONFIRM_COPY}</p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={busy || chosen.length === 0}
            onClick={() => onConfirm(chosen.map((c) => ({ candidate: c, includePhoto: c.type === 'photo' })))}
            className="flex-1 rounded-xl bg-[#1B4FD8] py-3 font-semibold disabled:opacity-40"
          >
            {busy ? 'Sending…' : `Send report with ${chosen.length} ${chosen.length === 1 ? 'message' : 'messages'}`}
          </button>
          <button type="button" onClick={() => setPreview(false)} disabled={busy} className="rounded-xl px-4 py-3 text-white/60">
            Back
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-white/80">Add messages as evidence</h3>
      <p className="mt-1 text-xs text-white/50">
        Pick the messages that show what happened. {rangeMode ? (rangeStart === null ? 'Tap the first message of the range.' : 'Now tap the last one.') : ''}
      </p>
      <div className="mt-2 flex gap-3 text-xs">
        <button type="button" onClick={() => { setRangeMode((r) => !r); setRangeStart(null) }} aria-pressed={rangeMode} className="text-[#7C9BFF] underline">
          {rangeMode ? 'Cancel range' : 'Pick a range'}
        </button>
        {picked.size > 0 && (
          <button type="button" onClick={() => { setPicked(new Set()); setPhotos(new Set()) }} className="text-white/50 underline">
            Clear
          </button>
        )}
      </div>
      <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto rounded-xl border border-white/10 p-2">
        {candidates.map((c, i) => (
          <li key={c.id}>
            <label className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm ${rangeStart === i ? 'bg-[#1B4FD8]/20' : ''}`}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => tap(i)} aria-label={`${who(c)}: ${c.type === 'photo' ? 'photo' : c.text}`} />
              <span className="min-w-0">
                <span className="block text-xs text-white/40">{who(c)}</span>
                <span className="block break-words text-white/85">{c.type === 'photo' ? '📷 Photo' : c.text}</span>
                {c.type === 'photo' && picked.has(c.id) && (
                  <span className="mt-1 flex items-center gap-1 text-xs text-white/60">
                    <input
                      type="checkbox"
                      checked={photos.has(c.id)}
                      onChange={(e) => setPhotos((p) => { const n = new Set(p); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n })}
                    />
                    Include this photo
                  </span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={chosen.length === 0} onClick={() => setPreview(true)} className="flex-1 rounded-xl bg-[#1B4FD8] py-3 font-semibold disabled:opacity-40">
          Review {chosen.length > 0 ? `(${chosen.length})` : ''}
        </button>
        <button type="button" onClick={onBack} className="rounded-xl px-4 py-3 text-white/60">
          Back
        </button>
      </div>
    </div>
  )
}
