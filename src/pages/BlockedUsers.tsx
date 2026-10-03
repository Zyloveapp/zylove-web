import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchBlockedUsers, unblockMember, type BlockedUser } from '../services/safety'

function blockedDate(ms: number): string {
  return ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
}

// People you've blocked. Unblocking only lifts the block: the match stays
// ended and the block still counts in behavior signals.
export default function BlockedUsers() {
  const navigate = useNavigate()
  const [blocked, setBlocked] = useState<BlockedUser[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [confirming, setConfirming] = useState<BlockedUser | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchBlockedUsers()
      .then((list) => !cancelled && setBlocked(list))
      .catch(() => !cancelled && setLoadError(true))
    return () => {
      cancelled = true
    }
  }, [])

  async function unblock(person: BlockedUser) {
    setBusy(true)
    setError(null)
    try {
      await unblockMember(person.uid)
      setBlocked((list) => list?.filter((b) => b.uid !== person.uid) ?? null)
      setConfirming(null)
    } catch {
      setError("Couldn't unblock. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-[calc(100dvh-7rem)] bg-gray-950 px-4 py-6 text-white">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-[#7C9BFF] hover:text-white">
            ← Back
          </button>
          <h1 className="text-2xl font-bold">Blocked users</h1>
        </div>
        <p className="text-sm text-white/50">Blocked users can't message you or appear in your feed.</p>

        <section className="rounded-2xl border border-white/10 bg-white/5">
          {loadError ? (
            <p className="px-5 py-4 text-sm text-red-400">Couldn't load your blocked users. Try again later.</p>
          ) : blocked === null ? (
            <p className="px-5 py-4 text-sm text-white/40">Loading…</p>
          ) : blocked.length === 0 ? (
            <p className="px-5 py-4 text-sm text-white/40">You haven't blocked anyone.</p>
          ) : (
            <ul className="divide-y divide-white/5">
              {blocked.map((b) => (
                <li key={b.uid} className="flex items-center justify-between gap-4 px-5 py-4">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{b.name}</span>
                    {b.blockedAt > 0 && <span className="block text-sm text-white/40">Blocked {blockedDate(b.blockedAt)}</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null)
                      setConfirming(b)
                    }}
                    className="shrink-0 rounded-full border border-white/20 px-4 py-1.5 text-sm font-medium text-white/80 hover:bg-white/10"
                  >
                    Unblock
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {confirming && (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="unblock-title"
          onClick={() => !busy && setConfirming(null)}
        >
          <div
            className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6"
            onClick={(e) => e.stopPropagation()}
          >
            <p id="unblock-title" className="text-lg font-semibold">
              Unblock {confirming.name}? They may appear in your feed again.
            </p>
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            <button
              type="button"
              onClick={() => void unblock(confirming)}
              disabled={busy}
              autoFocus
              className="mt-6 w-full rounded-xl bg-white/15 py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Unblocking…' : 'Unblock'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              disabled={busy}
              className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
