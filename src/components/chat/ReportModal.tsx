import { useEffect, useState } from 'react'
import { FirebaseError } from 'firebase/app'
import { submitReport } from '../../services/safety'
import { REPORT_ONLY_CATEGORY_DEFS, REVIEW_CATEGORY_DEFS } from '../../types/reviewCategories'
import { useModeStore, type Mode } from '../../store/modeStore'
import EvidencePicker from './EvidencePicker'
import { downloadEvidencePdf, submitEvidence, type EvidenceCandidate } from '../../services/evidence'

// Safety first (scam included — T&S Phase 2), then the rest of the negative categories.
const ORDER = ['felt_unsafe', 'aggressive', 'scam', 'pushed_boundaries', 'inappropriate', 'pressured_me', 'disrespectful']
const REPORT_CATEGORIES = [...REPORT_ONLY_CATEGORY_DEFS, ...REVIEW_CATEGORY_DEFS.filter((c) => c.tone === 'negative')].sort((a, b) => {
  const ia = ORDER.indexOf(a.id)
  const ib = ORDER.indexOf(b.id)
  return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib)
})

// Messages the server writes for people (curated profile, not a match, …).
function reportError(err: unknown): string {
  if (err instanceof FirebaseError && ['functions/failed-precondition', 'functions/permission-denied', 'functions/invalid-argument'].includes(err.code)) {
    return err.message
  }
  return "Couldn't send your report. Try again."
}

// A confidential report to the Zylove team: never shown to the reported
// person, never blocked by an earlier review or an empty chat.
export default function ReportModal({
  matchId,
  generation,
  partnerUid,
  name,
  onClose,
  mode,
  send,
  initialCategories = [],
  evidence,
}: {
  matchId: string
  // Which match between these two (MatchEntry.startedAt); 0 if unknown.
  generation: number
  partnerUid: string
  name: string
  onClose: () => void
  // The connection's mode (Play: red Done button); defaults to the current mode.
  mode?: Mode
  // Sends the report another way (a hidden Play connection: by match only).
  send?: (categories: string[]) => Promise<void>
  // Chosen when it opens (a scam banner's Report: ['scam']).
  initialCategories?: string[]
  // T&S Phase 4: the chat's messages, offered as evidence (decrypted here).
  evidence?: EvidenceCandidate[]
}) {
  const currentMode = useModeStore((s) => s.mode)
  const accentBg = (mode ?? currentMode) === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
  const [selected, setSelected] = useState<string[]>(initialCategories)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'categories' | 'evidence'>('categories')
  const [lockerId, setLockerId] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [submitting, onClose])

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((c) => c !== id) : [...s, id]))
  }

  async function submit(items: Parameters<typeof submitEvidence>[0]['items'] = []) {
    if (selected.length === 0 || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await (send ? send(selected) : submitReport(matchId, generation, partnerUid, selected))
      // The evidence goes with the report just filed — only what was picked.
      if (items.length) setLockerId((await submitEvidence({ matchId, reportedUid: partnerUid, generation, items })).lockerId)
      setDone(true)
    } catch (err) {
      setError(reportError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-title"
    >
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-6">
        {done ? (
          <div className="py-6 text-center">
            <p id="report-title" className="text-lg font-semibold">
              Report sent. Thank you for helping keep Zylove safe.
            </p>
            <p className="mt-2 text-sm text-white/60">
              Our team reviews every report. {name} won't be told about it.
            </p>
            {lockerId && (
              <button
                type="button"
                onClick={() => {
                  setPdfError(null)
                  downloadEvidencePdf(lockerId).catch(() => setPdfError("Couldn't make the PDF. Try again."))
                }}
                className="mt-4 text-sm font-semibold text-[#7C9BFF] underline hover:text-white"
              >
                Download your copy (PDF)
              </button>
            )}
            {pdfError && <p className="mt-2 text-sm text-red-400">{pdfError}</p>}
            <button
              type="button"
              onClick={onClose}
              autoFocus
              className={`mt-6 w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 ${accentBg}`}
            >
              Done
            </button>
          </div>
        ) : step === 'evidence' && evidence ? (
          <>
            <h2 id="report-title" className="text-xl font-bold">
              Report {name}
            </h2>
            {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
            <div className="mt-4">
              <EvidencePicker
                candidates={evidence}
                partnerName={name}
                busy={submitting}
                onBack={() => setStep('categories')}
                onConfirm={(items) => void submit(items)}
              />
            </div>
          </>
        ) : (
          <>
            <h2 id="report-title" className="text-xl font-bold">
              Report {name}
            </h2>
            <p className="mt-1 text-sm text-white/60">
              Reports are confidential and go straight to the Zylove team. {name} won't be told about your report.
            </p>
            <h3 className="mt-6 text-sm font-semibold text-white/80">What happened?</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {REPORT_CATEGORIES.map((c) => {
                const on = selected.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggle(c.id)}
                    aria-pressed={on}
                    className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                      on ? 'border-amber-400 bg-red-500/20 text-amber-200' : 'border-amber-500/30 bg-red-500/5 text-white/70'
                    }`}
                  >
                    <span aria-hidden>{c.emoji}</span> {c.label}
                  </button>
                )
              })}
            </div>
            <p className="mt-4 text-xs text-white/40">
              If you're in danger, contact local emergency services first.
            </p>
            {error && <p className="mt-4 text-center text-sm text-red-400">{error}</p>}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={selected.length === 0 || submitting}
              className="mt-6 w-full rounded-xl bg-red-600 py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              {submitting ? 'Sending…' : 'Send report'}
            </button>
            {evidence && evidence.length > 0 && !send && (
              <button
                type="button"
                onClick={() => setStep('evidence')}
                disabled={selected.length === 0 || submitting}
                className="mt-2 w-full rounded-xl border border-white/15 py-3 font-semibold text-white/85 hover:bg-white/5 disabled:opacity-30"
              >
                Add evidence (choose messages)
              </button>
            )}
            <button type="button" onClick={onClose} disabled={submitting} className="mt-2 w-full py-2 text-sm text-white/40 hover:text-white/60">
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  )
}
