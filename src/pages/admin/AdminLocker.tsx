import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { REPORT_ONLY_CATEGORY_DEFS, REVIEW_CATEGORY_DEFS } from '../../types/reviewCategories'
import {
  decideAppeal,
  decideLocker,
  holdLocker,
  listAppeals,
  listLocker,
  lockerDetail,
  type Appeal,
  type LockerItem,
  type LockerRow,
} from '../../services/adminLocker'

// T&S Phase 4 — /admin/locker: evidence filed with reports (list, filters,
// detail — opening one is logged), decisions, legal holds; and appeals.

const LABEL = new Map([...REVIEW_CATEGORY_DEFS, ...REPORT_ONLY_CATEGORY_DEFS].map((c) => [c.id, `${c.emoji} ${c.label}`]))
const label = (id: string) => LABEL.get(id) ?? id
const when = (t: number | null) => (t ? new Date(t).toLocaleString() : '—')
const VERDICT: Record<LockerItem['verdict'], { text: string; cls: string }> = {
  verified: { text: 'Verified', cls: 'bg-emerald-500/15 text-emerald-300' },
  unverified: { text: 'Unverified context', cls: 'bg-white/10 text-white/60' },
  mismatch: { text: "Doesn't match what was sent", cls: 'bg-red-500/15 text-red-300' },
}

function ReasonBox({ prompt, busy, onConfirm, onCancel, children }: { prompt: string; busy: boolean; onConfirm: (reason: string) => void; onCancel: () => void; children?: React.ReactNode }) {
  const [reason, setReason] = useState('')
  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-4">
      <p className="text-sm">{prompt}</p>
      {children}
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (logged)" aria-label="Reason" className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm" />
      <div className="flex gap-2">
        <button type="button" disabled={busy || reason.trim().length < 5} onClick={() => onConfirm(reason.trim())} className="rounded-lg bg-[#1B4FD8] px-3 py-1.5 text-sm font-semibold disabled:opacity-40">
          Confirm
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-white/60">
          Cancel
        </button>
      </div>
    </div>
  )
}

function Detail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<(LockerRow & { items: LockerItem[] }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<'actioned' | 'no_action' | 'hold' | 'release' | null>(null)
  const [ncmec, setNcmec] = useState(false)
  const [kind, setKind] = useState('legal')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    lockerDetail(id).then(setD).catch(() => setError("Couldn't open this evidence."))
  }, [id])
  useEffect(load, [load])

  async function run(reason: string) {
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      if (pending === 'hold' || pending === 'release') await holdLocker(id, pending === 'hold', kind, reason)
      else await decideLocker(id, pending, ncmec, reason)
      setPending(null)
      load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That failed.')
    } finally {
      setBusy(false)
    }
  }

  if (!d) return <p className="py-10 text-center text-white/50">{error ?? 'Loading…'}</p>
  return (
    <div className="space-y-4">
      <button type="button" onClick={onClose} className="text-sm text-[#7C9BFF] hover:text-white">
        ← All evidence
      </button>
      <h2 className="text-xl font-bold">
        {d.reporterName} reported {d.reportedName}
      </h2>
      <p className="text-sm text-white/50">
        {d.categories.map(label).join(' · ')} · filed {when(d.createdAt)} · {d.summary.verified} verified / {d.summary.unverified} unverified / {d.summary.mismatch} mismatched
      </p>
      <p className="text-sm text-white/50">
        {d.status === 'decided' ? `Decided: ${d.decision === 'actioned' ? 'action taken' : 'no action'} (${when(d.decidedAt)})${d.ncmec ? ' · child-safety case' : ''}` : 'Not decided yet'}
        {d.appealPending && ' · appeal pending (retention paused)'}
        {d.legalHold ? ` · ON HOLD (${d.legalHold.kind}) since ${when(d.legalHold.at)}: ${d.legalHold.reason}` : d.expiresAt ? ` · deleted after ${when(d.expiresAt)}` : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        {d.status === 'open' && (
          <>
            <button type="button" onClick={() => setPending('actioned')} className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm">Decide: action taken</button>
            <button type="button" onClick={() => setPending('no_action')} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">Decide: no action</button>
          </>
        )}
        {d.legalHold ? (
          <button type="button" onClick={() => setPending('release')} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">Release hold</button>
        ) : (
          <button type="button" onClick={() => setPending('hold')} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">Place legal hold</button>
        )}
      </div>
      {pending && (
        <ReasonBox prompt={pending === 'hold' ? 'Place a hold — nothing is deleted until it is released.' : pending === 'release' ? 'Release the hold.' : `Record the decision: ${pending === 'actioned' ? 'action taken' : 'no action'}.`} busy={busy} onConfirm={(r) => void run(r)} onCancel={() => setPending(null)}>
          {pending === 'actioned' && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ncmec} onChange={(e) => setNcmec(e.target.checked)} /> Child-safety / NCMEC case (keep 1 year)
            </label>
          )}
          {pending === 'hold' && (
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Hold type" className="rounded-lg border border-white/10 bg-gray-900 px-2 py-1 text-sm">
              <option value="legal">Legal hold</option>
              <option value="law_enforcement">Law-enforcement preservation</option>
              <option value="ncmec">NCMEC / child safety</option>
            </select>
          )}
        </ReasonBox>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <ul className="space-y-2">
        {d.items.map((it) => (
          <li key={it.msgId} className="rounded-xl border border-white/10 p-3">
            <p className="flex flex-wrap items-center gap-2 text-xs text-white/50">
              <span>{it.from === 'reported' ? d.reportedName : `${d.reporterName} (reporter)`}</span>
              <span>{when(it.sentAt)}</span>
              <span className={`rounded-full px-2 py-0.5 ${VERDICT[it.verdict].cls}`}>{VERDICT[it.verdict].text}</span>
            </p>
            {it.type === 'photo' && it.photo ? (
              <img src={`data:image/jpeg;base64,${it.photo}`} alt="Reported photo" className="mt-2 max-h-64 rounded-lg" />
            ) : (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">{it.text}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Appeals() {
  const [status, setStatus] = useState<'pending' | 'decided'>('pending')
  const [rows, setRows] = useState<Appeal[] | null>(null)
  const [deciding, setDeciding] = useState<{ id: string; decision: 'upheld' | 'overturned' } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    listAppeals(status).then((r) => setRows(r.appeals)).catch(() => setError("Couldn't load appeals."))
  }, [status])
  useEffect(load, [load])
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(['pending', 'decided'] as const).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)} aria-pressed={status === s} className={`rounded-full px-3 py-1 text-sm ${status === s ? 'bg-white/15' : 'text-white/50'}`}>
            {s === 'pending' ? 'Waiting' : 'Decided'}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {rows?.length === 0 && <p className="text-white/50">No appeals here.</p>}
      {rows?.map((a) => (
        <div key={a.id} className="rounded-xl border border-white/10 p-4">
          <p className="font-medium">{a.name}</p>
          <p className="text-xs text-white/40">
            {a.uid} · suspended {when(a.suspendedAt)}{a.suspendSource ? ` (${a.suspendSource})` : ''} · appealed {when(a.submittedAt)}
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{a.note}</p>
          {a.status === 'pending' ? (
            deciding?.id === a.id ? (
              <div className="mt-2">
                <ReasonBox prompt={deciding.decision === 'overturned' ? 'Overturn: the suspension is lifted.' : 'Uphold: the suspension stays.'} busy={busy} onCancel={() => setDeciding(null)} onConfirm={(reason) => {
                  setBusy(true)
                  decideAppeal(a.id, deciding.decision, reason).then(() => { setDeciding(null); load() }, (err: unknown) => setError(err instanceof Error ? err.message : 'That failed.')).finally(() => setBusy(false))
                }} />
              </div>
            ) : (
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => setDeciding({ id: a.id, decision: 'overturned' })} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm">Overturn</button>
                <button type="button" onClick={() => setDeciding({ id: a.id, decision: 'upheld' })} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">Uphold</button>
              </div>
            )
          ) : (
            <p className="mt-2 text-sm text-white/50">{a.status === 'overturned' ? 'Overturned' : 'Upheld'} {when(a.decidedAt)} — {a.decisionReason}</p>
          )}
        </div>
      ))}
    </div>
  )
}

export default function AdminLocker() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'evidence' | 'appeals'>('evidence')
  const [status, setStatus] = useState('open')
  const [category, setCategory] = useState('')
  const [rows, setRows] = useState<LockerRow[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    listLocker(status, category || null).then((r) => setRows(r.items)).catch(() => setError("Couldn't load the locker."))
  }, [status, category])
  useEffect(load, [load])

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 text-white">
      <div className="mb-4 flex items-center gap-3">
        <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-[#7C9BFF] hover:text-white">← Back</button>
        <h1 className="text-xl font-bold">Evidence locker</h1>
      </div>
      <p className="mb-4 text-xs text-white/40">Every view here is logged.</p>
      <div className="mb-4 flex gap-2">
        {(['evidence', 'appeals'] as const).map((t) => (
          <button key={t} type="button" onClick={() => { setTab(t); setOpen(null) }} aria-pressed={tab === t} className={`rounded-full px-3 py-1 text-sm ${tab === t ? 'bg-white/15' : 'text-white/50'}`}>
            {t === 'evidence' ? 'Evidence' : 'Appeals'}
          </button>
        ))}
      </div>
      {tab === 'appeals' ? (
        <Appeals />
      ) : open ? (
        <Detail id={open} onClose={() => setOpen(null)} onChanged={load} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="rounded-lg border border-white/10 bg-gray-900 px-2 py-1 text-sm">
              <option value="open">Not decided</option>
              <option value="decided">Decided</option>
              <option value="held">On hold</option>
              <option value="all">All</option>
            </select>
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="rounded-lg border border-white/10 bg-gray-900 px-2 py-1 text-sm">
              <option value="">Any category</option>
              {[...LABEL].map(([id, l]) => (
                <option key={id} value={id}>{l}</option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {rows === null ? (
            <p className="text-white/50">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-white/50">Nothing here.</p>
          ) : (
            <ul className="divide-y divide-white/10 rounded-xl border border-white/10">
              {rows.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpen(r.id)} className="w-full px-4 py-3 text-left hover:bg-white/[0.03]">
                    <p className="font-medium">{r.reporterName} → {r.reportedName}</p>
                    <p className="text-xs text-white/50">
                      {r.categories.map(label).join(' · ')} · {r.summary.items} items ({r.summary.verified} verified) · {when(r.createdAt)}
                      {r.legalHold ? ' · ON HOLD' : ''}{r.status === 'decided' ? ` · ${r.decision === 'actioned' ? 'action taken' : 'no action'}` : ''}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
