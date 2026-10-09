import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { deleteContactMessage, listContactMessages, setContactHandled, type ContactFilter, type ContactRow } from '../../services/adminContact'

const FILTERS: { key: ContactFilter; label: string }[] = [
  { key: 'unhandled', label: 'To handle' },
  { key: 'handled', label: 'Handled' },
  { key: 'all', label: 'All' },
]

function when(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// /admin/contact: messages from the public /contact form, newest first.
// Mark one handled once it's answered (by email, outside the app); delete
// spam. Kept 12 months, then purged.
export default function AdminContact() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<ContactFilter>('unhandled')
  const [rows, setRows] = useState<ContactRow[] | null>(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const load = useCallback(() => {
    setRows(null)
    setError(null)
    listContactMessages(filter)
      .then((r) => {
        setRows(r.messages)
        setMore(r.more)
      })
      .catch(() => setError("Couldn't load contact messages."))
  }, [filter])

  useEffect(load, [load])

  async function loadMore() {
    const last = rows?.[rows.length - 1]
    if (!last) return
    setBusy('more')
    try {
      const r = await listContactMessages(filter, last.id)
      setRows((rs) => [...(rs ?? []), ...r.messages])
      setMore(r.more)
    } catch {
      setError("Couldn't load more messages.")
    }
    setBusy(null)
  }

  async function toggle(row: ContactRow) {
    setBusy(row.id)
    setError(null)
    try {
      await setContactHandled(row.id, !row.handled)
      // Out of this view once its state no longer matches the filter.
      setRows((rs) =>
        filter === 'all' ? (rs?.map((r) => (r.id === row.id ? { ...r, handled: !row.handled, handledAt: row.handled ? null : Date.now() } : r)) ?? rs) : (rs?.filter((r) => r.id !== row.id) ?? rs),
      )
    } catch {
      setError("Couldn't update that message. Try again.")
    }
    setBusy(null)
  }

  async function remove(id: string) {
    setBusy(id)
    setError(null)
    try {
      await deleteContactMessage(id)
      setRows((rs) => rs?.filter((r) => r.id !== id) ?? rs)
      setConfirming(null)
    } catch {
      setError("Couldn't delete that message. Try again.")
    }
    setBusy(null)
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 text-white">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-[#7C9BFF] hover:text-white">
          ← Back
        </button>
        <h1 className="text-xl font-bold">Contact messages</h1>
      </div>
      <p className="mt-2 text-xs text-white/40">From the /contact form. Reply by email, then mark it handled. Every view here is logged.</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`rounded-full px-3 py-1 text-sm ${filter === f.key ? 'bg-white/15' : 'text-white/50'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      {!error && rows === null && <div className="mx-auto mt-12 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />}
      {rows?.length === 0 && <p className="mt-12 text-center text-sm text-white/50">{filter === 'unhandled' ? 'Nothing to handle.' : 'No messages.'}</p>}

      {rows && rows.length > 0 && (
        <ul className="mt-4 space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="min-w-0 break-words font-semibold">
                  {r.name}
                  {r.handled && <span className="ml-2 rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-normal text-emerald-300">Handled</span>}
                </p>
                <p className="text-xs text-white/40">{when(r.createdAt)}</p>
              </div>
              <a href={`mailto:${r.email}`} className="mt-0.5 block break-all text-sm text-[#7C9BFF] hover:text-white">
                {r.email}
              </a>
              <p className="mt-1 text-xs text-white/40">
                {r.topic || 'No topic'}
                {r.uid && ' · signed in'}
              </p>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm text-white/80">{r.message}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void toggle(r)}
                  disabled={busy !== null}
                  className="rounded-xl border border-white/15 px-3 py-2 text-sm font-semibold hover:bg-white/10 disabled:opacity-50"
                >
                  {r.handled ? 'Mark not handled' : 'Mark handled'}
                </button>
                {confirming === r.id ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void remove(r.id)}
                      disabled={busy !== null}
                      className="rounded-xl bg-red-600 px-3 py-2 text-sm font-semibold hover:bg-red-500 disabled:opacity-50"
                    >
                      {busy === r.id ? 'Deleting…' : 'Delete for good'}
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} disabled={busy !== null} className="px-2 py-2 text-sm text-white/50 hover:text-white">
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(r.id)}
                    disabled={busy !== null}
                    className="rounded-xl border border-red-500/40 px-3 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {more && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={busy !== null}
          className="mt-4 w-full rounded-xl border border-white/10 py-3 text-sm font-semibold text-white/70 hover:bg-white/5 disabled:opacity-50"
        >
          {busy === 'more' ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
