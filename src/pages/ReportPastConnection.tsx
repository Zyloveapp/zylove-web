import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReviewModal from '../components/chat/ReviewModal'
import { relativeTime } from '../services/matches'
import { fetchPastConnections, type PastConnection } from '../services/pastConnections'

const DONE_TEXT = 'Report submitted. Thank you for helping keep Zylove safe.'

// Report someone from the last 90 days, including matches that have ended.
// Names and dates only — no photos, no conversation.
export default function ReportPastConnection() {
  const navigate = useNavigate()
  const [connections, setConnections] = useState<PastConnection[] | null>(null)
  const [error, setError] = useState(false)
  const [reporting, setReporting] = useState<PastConnection | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchPastConnections()
      .then((list) => !cancelled && setConnections(list))
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="min-h-[calc(100dvh-7rem)] lg:min-h-[calc(100dvh-7.5rem)] bg-gray-950 px-4 py-6 text-white">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="text-sm font-medium text-[#7C9BFF] hover:text-white"
          >
            ← Back
          </button>
          <h1 className="text-2xl font-bold">Report a past connection</h1>
        </div>
        <p className="text-sm text-white/50">
          Past connections are kept for 90 days. We only keep names and dates — your conversations remain private.
        </p>

        <section className="rounded-2xl border border-white/10 bg-white/5">
          {error ? (
            <p className="px-5 py-4 text-sm text-red-400">Couldn't load your connections. Try again later.</p>
          ) : connections === null ? (
            <p className="px-5 py-4 text-sm text-white/40">Loading…</p>
          ) : connections.length === 0 ? (
            <p className="px-5 py-4 text-sm text-white/40">No connections in the last 90 days.</p>
          ) : (
            <ul className="divide-y divide-white/5">
              {connections.map((c) => (
                <li key={c.matchId} className="flex items-center justify-between gap-4 px-5 py-4">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="block text-sm text-white/40">Matched {relativeTime(c.matchedAt)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setReporting(c)}
                    className="shrink-0 rounded-full border border-red-400/40 px-4 py-1.5 text-sm font-medium text-red-300 hover:bg-red-500/10"
                  >
                    Report
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {reporting && (
        <ReviewModal
          matchId={reporting.matchId}
          partnerUid={reporting.otherUid}
          name={reporting.name}
          doneText={DONE_TEXT}
          onClose={() => setReporting(null)}
        />
      )}
    </div>
  )
}
