import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getReports,
  moderate,
  type AccountStatus,
  type GoodActor,
  type ModerateAction,
  type ReportedUser,
} from '../../services/adminReports'
import { REVIEW_CATEGORY_DEFS } from '../../types/reviewCategories'

// /admin/reports: everyone reported, urgent first, with the moderation
// actions; and a "good actors" tab for thank-you notes. Reporter identities
// are never shown (the server returns counts only).

const LABELS = new Map(REVIEW_CATEGORY_DEFS.map((c) => [c.id, `${c.emoji} ${c.label}`]))
const label = (id: string) => LABELS.get(id) ?? id.replace(/_/g, ' ')

const fmtDate = (ms: number | null) =>
  ms === null ? '—' : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

const STATUS_STYLE: Record<AccountStatus, string> = {
  active: 'bg-emerald-500/15 text-emerald-300',
  suspended: 'bg-amber-500/15 text-amber-300',
  banned: 'bg-red-500/20 text-red-300',
  deleted: 'bg-white/10 text-white/50',
}

type Pending = { user: { uid: string; name: string }; action: ModerateAction } | null

export default function AdminReports() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'reported' | 'good'>('reported')
  const [data, setData] = useState<{ reported: ReportedUser[]; goodActors: GoodActor[] } | null>(null)
  const [error, setError] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    getReports()
      .then((d) => {
        setData(d)
        setError(false)
      })
      .catch(() => setError(true))
  }, [])
  useEffect(load, [load])

  const reported = (data?.reported ?? []).filter((u) => showResolved || u.pendingCount > 0)
  const urgentCount = (data?.reported ?? []).filter((u) => u.pendingCount > 0 && u.priority === 'urgent').length

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 text-white">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-[#7C9BFF] hover:text-white">
          ← Back
        </button>
        <h1 className="text-xl font-bold">Reports</h1>
        {urgentCount > 0 && (
          <span className="rounded-full bg-[#E03131] px-2 py-0.5 text-xs font-semibold">{urgentCount} urgent</span>
        )}
      </div>
      <p className="mt-1 text-xs text-white/40">Admins only. Reporter identities are never shown.</p>

      <div className="mt-5 flex gap-2">
        {(['reported', 'good'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${tab === t ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white'}`}
          >
            {t === 'reported' ? 'Reported members' : 'Good actors'}
          </button>
        ))}
      </div>

      {notice && <p className="mt-4 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
      {error && <p className="mt-8 text-center text-sm text-red-400">Couldn't load reports.</p>}
      {!error && data === null && <div className="mx-auto mt-12 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />}

      {data && tab === 'reported' && (
        <>
          <label className="mt-4 flex items-center gap-2 text-sm text-white/60">
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
            Show resolved
          </label>
          {reported.length === 0 ? (
            <p className="mt-10 text-center text-sm text-white/50">{showResolved ? 'No reports yet.' : 'No open reports. ✦'}</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {reported.map((u) => (
                <ReportedCard
                  key={u.uid}
                  user={u}
                  expanded={open === u.uid}
                  onToggle={() => setOpen(open === u.uid ? null : u.uid)}
                  onAction={(action) => setPending({ user: u, action })}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {data && tab === 'good' && (
        <ul className="mt-4 divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          {data.goodActors.length === 0 && <li className="px-4 py-6 text-center text-sm text-white/50">No top-rated members yet.</li>}
          {data.goodActors.map((g) => (
            <li key={g.uid} className="flex items-center gap-3 px-4 py-3">
              <Avatar url={g.photoURL} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{g.name}</span>
                <span className="block text-xs text-white/50">
                  {g.tier} · {g.positiveCount} positive of {g.reviewCount} reviews
                  {g.lastThankedAt !== null && ` · thanked ${fmtDate(g.lastThankedAt)}`}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setPending({ user: g, action: 'thank' })}
                className="rounded-xl border border-[#1B4FD8]/50 px-3 py-1.5 text-sm text-[#9DB4FF] hover:bg-[#1B4FD8]/15"
              >
                Send thank you
              </button>
            </li>
          ))}
        </ul>
      )}

      {pending && (
        <ActionModal
          pending={pending}
          onClose={() => setPending(null)}
          onDone={(text) => {
            setPending(null)
            setNotice(text)
            load()
          }}
        />
      )}
    </div>
  )
}

function Avatar({ url }: { url: string | null }) {
  return url ? (
    <img src={url} alt="" className="h-11 w-11 shrink-0 rounded-full object-cover" />
  ) : (
    <span className="h-11 w-11 shrink-0 rounded-full bg-white/10" aria-hidden />
  )
}

function ReportedCard({
  user: u,
  expanded,
  onToggle,
  onAction,
}: {
  user: ReportedUser
  expanded: boolean
  onToggle: () => void
  onAction: (a: ModerateAction) => void
}) {
  const live = u.status === 'active' || u.status === 'suspended'
  const btn = 'rounded-xl px-3 py-1.5 text-sm font-medium disabled:opacity-40'
  return (
    <li
      className={`overflow-hidden rounded-2xl border bg-white/5 ${
        u.pendingCount > 0 && u.priority === 'urgent' ? 'border-[#E03131]/60' : 'border-white/10'
      }`}
    >
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-white/[0.03]">
        <Avatar url={u.photoURL} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{u.name}</span>
            {u.pendingCount > 0 && (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                  u.priority === 'urgent' ? 'bg-[#E03131] text-white' : 'bg-white/10 text-white/70'
                }`}
              >
                {u.priority}
              </span>
            )}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[u.status]}`}>
              {u.status}
              {u.status === 'suspended' && u.suspendedUntil !== null && ` until ${fmtDate(u.suspendedUntil)}`}
            </span>
            {u.isAdmin && <span className="text-[11px] text-white/40">admin</span>}
          </span>
          <span className="mt-0.5 block text-xs text-white/50">
            Joined {fmtDate(u.joinedAt)} · {u.pendingCount} open {u.pendingCount === 1 ? 'report' : 'reports'} from {u.pendingReporters}{' '}
            {u.pendingReporters === 1 ? 'person' : 'people'} · {u.totalReporters} total
            {u.lastWarnedAt !== null && ` · warned ${fmtDate(u.lastWarnedAt)}`}
          </span>
          <span className="mt-2 flex flex-wrap gap-1.5">
            {u.categories.map((c) => (
              <span key={c.category} className="rounded-full border border-amber-500/30 bg-red-500/5 px-2 py-0.5 text-xs text-white/70">
                {label(c.category)}
                {c.count > 1 && ` ×${c.count}`}
              </span>
            ))}
          </span>
        </span>
        <span className="text-white/30" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-white/5 px-4 py-3">
          <ul className="space-y-1.5 text-sm">
            {u.reports.map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-2 text-white/70">
                <span className="w-24 shrink-0 text-xs text-white/40">{fmtDate(r.reportedAt)}</span>
                <span className={r.priority === 'urgent' ? 'font-semibold text-red-300' : ''}>{r.categories.map(label).join(', ')}</span>
                <span className="text-xs text-white/40">
                  · {r.status}
                  {r.source !== 'web' && ` · ${r.source}`}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" disabled={!live || u.isAdmin} onClick={() => onAction('warn')} className={`${btn} bg-amber-600/80 text-white`}>
              Warn
            </button>
            {u.status === 'suspended' ? (
              <button type="button" disabled={u.isAdmin} onClick={() => onAction('unsuspend')} className={`${btn} border border-white/20 text-white`}>
                Lift suspension
              </button>
            ) : (
              <button type="button" disabled={!live || u.isAdmin} onClick={() => onAction('suspend')} className={`${btn} bg-orange-700 text-white`}>
                Suspend…
              </button>
            )}
            <button type="button" disabled={u.status === 'banned' || u.isAdmin} onClick={() => onAction('ban')} className={`${btn} bg-red-700 text-white`}>
              Delete &amp; ban
            </button>
            <button type="button" disabled={u.pendingCount === 0} onClick={() => onAction('clear')} className={`${btn} border border-white/20 text-white/80`}>
              Clear reports
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

const COPY: Record<ModerateAction, { title: (n: string) => string; body: string; confirm: string; tone: string }> = {
  warn: {
    title: (n) => `Warn ${n}`,
    body: 'They see this the next time they open Zylove, and get a text if they have texts on. Their open reports are marked actioned.',
    confirm: 'Send warning',
    tone: 'bg-amber-600',
  },
  suspend: {
    title: (n) => `Suspend ${n}`,
    body: "Locks the account: hidden everywhere, can't sign in, current sessions end within the hour. Lifted automatically when the period ends.",
    confirm: 'Suspend',
    tone: 'bg-orange-700',
  },
  unsuspend: {
    title: (n) => `Lift ${n}'s suspension`,
    body: 'They can sign in again and are visible as before.',
    confirm: 'Lift suspension',
    tone: 'bg-[#1B4FD8]',
  },
  ban: {
    title: (n) => `Delete & ban ${n}`,
    body: 'Permanent. The account is deleted and the phone number can never sign in or create a new account again.',
    confirm: 'Delete & ban',
    tone: 'bg-red-700',
  },
  clear: {
    title: (n) => `Clear reports on ${n}`,
    body: 'Dismisses their open reports as unfounded. Any automatic sign-in block or suspension those reports caused is lifted.',
    confirm: 'Clear reports',
    tone: 'bg-white/20',
  },
  thank: {
    title: (n) => `Thank ${n}`,
    body: 'They see this the next time they open Zylove, and get a text if they have texts on.',
    confirm: 'Send thank you ✦',
    tone: 'bg-[#1B4FD8]',
  },
}

function ActionModal({
  pending,
  onClose,
  onDone,
}: {
  pending: NonNullable<Pending>
  onClose: () => void
  onDone: (notice: string) => void
}) {
  const { user, action } = pending
  const copy = COPY[action]
  const [message, setMessage] = useState('')
  const [days, setDays] = useState<30 | 60 | 90>(30)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const withMessage = action === 'warn' || action === 'thank'
  const ready = action !== 'ban' || typed.trim() === 'BAN'

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const res = await moderate(user.uid, action, {
        ...(action === 'suspend' ? { days } : {}),
        ...(withMessage && message.trim() ? { message: message.trim() } : {}),
      })
      const parts = [`${copy.confirm.replace(' ✦', '')} — done for ${user.name}.`]
      if (res.texted) parts.push('Texted.')
      if (action === 'ban') parts.push(res.phoneBanned ? 'Phone number banned.' : 'No phone number on file to ban.')
      onDone(parts.join(' '))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't do that. Try again.")
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="moderate-title"
    >
      <div className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-6">
        <h2 id="moderate-title" className="text-xl font-bold">
          {copy.title(user.name)}
        </h2>
        <p className="mt-2 text-sm text-white/60">{copy.body}</p>

        {action === 'suspend' && (
          <div className="mt-4 flex gap-2">
            {([30, 60, 90] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`flex-1 rounded-xl border py-2 text-sm font-semibold ${
                  days === d ? 'border-orange-400 bg-orange-500/20 text-orange-200' : 'border-white/15 text-white/60'
                }`}
              >
                {d} days
              </button>
            ))}
          </div>
        )}

        {withMessage && (
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, 500))}
            rows={4}
            placeholder="Optional — leave blank for the standard message."
            className="mt-4 w-full resize-none rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none"
          />
        )}

        {action === 'ban' && (
          <label className="mt-4 block">
            <span className="mb-1 block text-xs text-white/50">Type BAN to confirm</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoCapitalize="characters"
              autoComplete="off"
              className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-white focus:border-red-400/60 focus:outline-none"
            />
          </label>
        )}

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !ready}
          className={`mt-6 w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40 ${copy.tone}`}
        >
          {busy ? 'Working…' : copy.confirm}
        </button>
        <button type="button" onClick={onClose} disabled={busy} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
          Cancel
        </button>
      </div>
    </div>
  )
}
