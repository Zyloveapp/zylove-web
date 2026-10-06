import { useEffect, useState } from 'react'
import ReportModal from '../chat/ReportModal'
import {
  blockLockedPlayConnection,
  listLockedPlayConnections,
  reportLockedPlayConnection,
  type LockedConnection,
} from '../../services/lockedPlay'

// Shown in Links when Play isn't on the user's plan right now but they have
// Play connections: those are hidden until Play is back (nothing is lost),
// and each can still be reported or blocked. Nothing about the other person
// is shown — not even who they are.
export default function LockedPlayConnections({ showEmpty = false }: { showEmpty?: boolean }) {
  const [connections, setConnections] = useState<LockedConnection[] | null>(null)
  const [reporting, setReporting] = useState<string | null>(null)
  const [confirmBlock, setConfirmBlock] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listLockedPlayConnections()
      .then((c) => !cancelled && setConnections(c))
      .catch(() => !cancelled && setConnections([]))
    return () => {
      cancelled = true
    }
  }, [])

  if (!connections) return null
  if (connections.length === 0) {
    return showEmpty ? <p className="mx-4 my-3 text-sm text-white/50">No hidden Play connections.</p> : null
  }

  async function block(matchId: string) {
    setBusy(true)
    setError(null)
    try {
      await blockLockedPlayConnection(matchId)
      setConnections((c) => (c ?? []).filter((x) => x.matchId !== matchId))
      setConfirmBlock(null)
    } catch {
      setError("Couldn't block right now. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const n = connections.length
  return (
    <section className="mx-4 my-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4" aria-label="Hidden Play connections">
      <h2 className="text-sm font-semibold text-white/90">
        {n === 1 ? '1 Play connection is hidden' : `${n} Play connections are hidden`}
      </h2>
      <p className="mt-1 text-sm text-white/50">
        Play isn't on your plan right now, so these are hidden. Nothing is lost — they come back when Play does. You can
        still report or block them.
      </p>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <ul className="mt-3 divide-y divide-white/5">
        {connections.map((c, i) => (
          <li key={c.matchId} className="flex items-center justify-between gap-3 py-2">
            <span className="text-sm text-white/70">
              Play connection {i + 1}
              {c.matchedAt > 0 && (
                <span className="text-white/40">
                  {' '}
                  · {new Date(c.matchedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              )}
            </span>
            {confirmBlock === c.matchId ? (
              <span className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void block(c.matchId)}
                  className="rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40"
                >
                  {busy ? 'Blocking…' : 'Block'}
                </button>
                <button type="button" onClick={() => setConfirmBlock(null)} className="px-2 py-1 text-xs text-white/50">
                  Cancel
                </button>
              </span>
            ) : (
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setReporting(c.matchId)}
                  className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/70 hover:text-white"
                >
                  Report
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmBlock(c.matchId)}
                  className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/70 hover:text-white"
                >
                  Block
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {reporting && (
        <ReportModal
          matchId={reporting}
          generation={0}
          partnerUid=""
          name="this person"
          mode="spark"
          send={(categories) => reportLockedPlayConnection(reporting, categories)}
          onClose={() => setReporting(null)}
        />
      )}
    </section>
  )
}
