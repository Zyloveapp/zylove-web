import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listDeletions, purgeAccount, type DeletionStage, type PendingDeletion } from '../../services/adminTools'

const DAY_MS = 24 * 60 * 60 * 1000

const STAGE_LABEL: Record<DeletionStage, string> = {
  grace: 'Grace period · can still cancel',
  deleted: 'Deleted · restorable for 90 days',
  record: 'Data purged · recovery record left',
}

function date(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function daysLeft(ms: number | null): number | null {
  return ms === null ? null : Math.max(0, Math.ceil((ms - Date.now()) / DAY_MS))
}

// Red within 7 days, amber within 30, white later.
function urgency(days: number | null): string {
  if (days === null) return 'text-white'
  if (days <= 7) return 'text-red-400'
  if (days <= 30) return 'text-amber-400'
  return 'text-white'
}

// /admin/deletions: every account on its way out, soonest permanent
// deletion first, with a manual "Delete now".
export default function AdminDeletions() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<PendingDeletion[] | null>(null)
  const [error, setError] = useState(false)
  const [confirming, setConfirming] = useState<PendingDeletion | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    listDeletions()
      .then((d) => {
        setRows(d)
        setError(false)
      })
      .catch(() => setError(true))
  }, [])

  useEffect(load, [load])

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 text-white">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-[#7C9BFF] hover:text-white">
          ← Back
        </button>
        <h1 className="text-xl font-bold">Deletion queue</h1>
        {rows && rows.length > 0 && <span className="text-sm text-white/40">{rows.length}</span>}
      </div>

      {notice && (
        <p className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>
      )}
      {error && <p className="mt-8 text-center text-sm text-red-400">Couldn't load the deletion queue.</p>}
      {!error && rows === null && <div className="mx-auto mt-12 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />}
      {rows?.length === 0 && <p className="mt-12 text-center text-sm text-white/50">No pending deletions.</p>}

      {rows && rows.length > 0 && (
        <ul className="mt-6 divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          {rows.map((r) => {
            const days = daysLeft(r.permanentAt)
            return (
              <li key={r.uid} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {r.displayName ?? 'Anonymous'}
                    {r.banned && <span className="ml-2 rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-300">Banned</span>}
                  </p>
                  <p className="text-xs text-white/40">
                    {r.phoneLast4 ? `Phone ···${r.phoneLast4}` : 'No phone on file'} · {STAGE_LABEL[r.stage]}
                  </p>
                  <p className="mt-1 text-sm text-white/60">
                    Deleted {date(r.deletedAt)} · permanent {r.permanentAt === null ? (r.banned ? 'never (ban kept)' : '—') : date(r.permanentAt)}
                  </p>
                </div>
                <div className={`text-right text-sm font-semibold ${urgency(days)}`}>
                  {days === null ? '—' : days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'}`}
                </div>
                <button
                  type="button"
                  onClick={() => setConfirming(r)}
                  className="rounded-xl border border-red-500/40 px-3 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/10"
                >
                  Delete now
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {confirming && (
        <ConfirmPurge
          row={confirming}
          onClose={() => setConfirming(null)}
          onDone={(keptBan) => {
            setRows((rs) => rs?.filter((r) => r.uid !== confirming.uid) ?? rs)
            setNotice(
              keptBan
                ? 'Account deleted. The ban record was kept so this number stays blocked.'
                : 'Account permanently deleted.',
            )
            setConfirming(null)
          }}
        />
      )}
    </div>
  )
}

function ConfirmPurge({ row, onClose, onDone }: { row: PendingDeletion; onClose: () => void; onDone: (keptBan: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      const { keptBannedRecord } = await purgeAccount(row.uid)
      onDone(keptBannedRecord)
    } catch {
      setError("Couldn't delete this account. Try again.")
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="purge-title"
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
    >
      <div className="w-full rounded-t-2xl border border-red-500/30 bg-gray-950 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
        <h2 id="purge-title" className="text-xl font-bold">
          Permanently delete this account now?
        </h2>
        <p className="mt-2 text-sm text-white/60">
          {row.displayName ?? 'Anonymous'}
          {row.phoneLast4 ? ` (···${row.phoneLast4})` : ''}. This cannot be undone.
          {row.stage === 'grace' && ' They asked to delete but can still cancel — this skips that.'}
        </p>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy}
          className="mt-6 w-full rounded-xl bg-red-600 py-3 font-semibold text-white hover:bg-red-500 disabled:opacity-50"
        >
          {busy ? 'Deleting…' : 'Delete permanently'}
        </button>
        <button type="button" onClick={onClose} disabled={busy} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
          Cancel
        </button>
      </div>
    </div>
  )
}
