import { useState } from 'react'
import { FirebaseError } from 'firebase/app'
import { APPEAL_NOTE_MAX, submitAppeal, type Suspension } from '../services/appeals'
import { BRAND } from '../brand/zylove'

// T&S Phase 4 — shown when a suspended account tries to sign in: what's
// happening, and (once per suspension) a short appeal to a person.
export default function SuspendedPanel({ suspension, onBack }: { suspension: Suspension; onBack: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const until = suspension.until ? new Date(suspension.until).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null
  const canAppeal = suspension.appeal === 'none' && suspension.token !== null && !sent

  async function send() {
    if (!suspension.token) return
    setBusy(true)
    setError(null)
    try {
      await submitAppeal(suspension.token, note.trim())
      setSent(true)
    } catch (err) {
      setError(err instanceof FirebaseError && err.code.startsWith('functions/') && err.message ? err.message : "Couldn't send your appeal. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3" role="region" aria-labelledby="suspended-title">
      <h2 id="suspended-title" className="text-lg font-semibold text-white">
        Your account is suspended
      </h2>
      <p className="text-sm text-white/60">
        {suspension.pendingReview
          ? 'It was suspended while our team reviews reports about it.'
          : until
            ? `It's suspended until ${until}.`
            : 'It was suspended after a review of reports about it.'}
      </p>
      {sent || suspension.appeal === 'pending' ? (
        <p className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/70">
          Your appeal is with our team. A person reads every appeal; sign in again later to see if it's been decided.
        </p>
      ) : suspension.appeal === 'upheld' ? (
        <p className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/70">Your appeal was reviewed and the suspension stands.</p>
      ) : canAppeal ? (
        <>
          <label className="block space-y-1">
            <span className="text-sm text-white/70">Think we got it wrong? Tell us why (one appeal per suspension).</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, APPEAL_NOTE_MAX))}
              rows={4}
              maxLength={APPEAL_NOTE_MAX}
              aria-label="Your appeal"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
            />
            <span className="block text-right text-xs text-white/40">
              {note.length}/{APPEAL_NOTE_MAX}
            </span>
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || note.trim().length < 10}
            className="w-full rounded-xl bg-[#1B4FD8] px-4 py-3 font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Sending…' : 'Send appeal'}
          </button>
        </>
      ) : (
        <p className="text-sm text-white/60">Questions? Email {BRAND.supportEmail}.</p>
      )}
      <button type="button" onClick={onBack} className="w-full text-sm text-white/50 underline hover:text-white">
        Back
      </button>
    </div>
  )
}
