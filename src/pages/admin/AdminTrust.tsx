import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import StoredImg from '../../components/StoredImg'
import {
  getTrustDetail,
  getTrustQueue,
  searchUsers,
  trustAction,
  viewProfile,
  type FlagStatus,
  type TrustAction,
  type TrustDetail,
  type TrustSummary,
} from '../../services/adminTrust'

// /admin/trust: flagged accounts by risk score, why each was flagged, the
// signals against their group, linked accounts, reports — and the actions
// (dismiss, reduce visibility, suspend), each with a reason. A directory
// tab searches by name, user id or phone. Everything here is audit-logged.

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname
  } catch {
    return 'link'
  }
}
const fmtDate = (ms: number | null) =>
  ms === null ? '—' : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

const FEATURE_LABELS: Record<string, string> = {
  swipes7d: 'Swipes (7 days)',
  swipesPerDay: 'Swipes a day',
  interestedRatio: 'Share liked',
  medianSwipeSec: 'Seconds per swipe',
  capHitDays30: 'Cap-hit days (30d)',
  matchCount7d: 'Matches (7 days)',
  conversationsStarted: 'Openers sent',
  conversationsReceived: 'Openers received',
  openerReplyRate: 'Their openers answered',
  replyRate: 'Replies to openers',
  messagesSent: 'Messages sent',
  unmatchAfterExchange: 'Unmatches after talking',
  duplicateOpenerRecipients: 'Same opener → people (24h)',
  duplicateOpenerSenders: 'Same opener ← accounts (24h)',
  reporters90d: 'Reporters (90d)',
  urgentReports90d: 'Urgent reports (90d)',
  blocksReceived: 'Blocks received',
  accountAgeDays: 'Account age (days)',
  photoCount: 'Photos',
  pendingPhotos: 'Photos awaiting review',
  photoRejections90d: 'Photo rejections (90d)',
  sharedDeviceAccounts: 'Accounts on same device',
  sharedIpAccounts: 'Accounts on same address',
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v < 1 ? `${Math.round(v * 100)}%` : v.toFixed(1)
  return String(v)
}

function ScoreBadge({ score }: { score: number | null }) {
  const s = score ?? 0
  const tone = s >= 70 ? 'bg-red-500/20 text-red-300' : s >= 40 ? 'bg-amber-500/15 text-amber-300' : 'bg-white/10 text-white/60'
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-sm font-bold ${tone}`}>{score ?? '—'}</span>
}

function Avatar({ photoRef }: { photoRef: string | null }) {
  return photoRef ? (
    <StoredImg src={photoRef} alt="" className="h-11 w-11 shrink-0 rounded-full object-cover" />
  ) : (
    <span className="h-11 w-11 shrink-0 rounded-full bg-white/10" />
  )
}

function Row({ s, onOpen }: { s: TrustSummary; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-white/[0.04]">
        <Avatar photoRef={s.photoRef} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold">{s.name}</span>
            {s.suspended && <span className="rounded-full bg-amber-500/15 px-2 text-xs text-amber-300">suspended</span>}
            {s.visibilityReduced && <span className="rounded-full bg-white/10 px-2 text-xs text-white/60">reduced</span>}
          </span>
          <span className="block truncate text-sm text-white/50">{s.reasons[0]?.text ?? 'No reasons recorded'}</span>
        </span>
        <ScoreBadge score={s.score} />
      </button>
    </li>
  )
}

const ACTIONS: { id: TrustAction; label: string; tone: string }[] = [
  { id: 'dismiss', label: 'Dismiss flag', tone: 'bg-white/10' },
  { id: 'reduce_visibility', label: 'Reduce visibility', tone: 'bg-white/15' },
  { id: 'restore_visibility', label: 'Restore visibility', tone: 'bg-white/10' },
  { id: 'suspend', label: 'Suspend', tone: 'bg-amber-600' },
  { id: 'lift_suspension', label: 'Lift suspension', tone: 'bg-emerald-700' },
]

function Detail({ uid, onClose, onChanged }: { uid: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<TrustDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof viewProfile>> | null>(null)
  const [pending, setPending] = useState<TrustAction | null>(null)
  const [reason, setReason] = useState('')
  const [days, setDays] = useState(30)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    getTrustDetail(uid)
      .then(setD)
      .catch(() => setError("Couldn't load this account."))
  }, [uid])
  useEffect(load, [load])

  async function run() {
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      await trustAction(uid, pending, reason.trim(), pending === 'suspend' ? days : undefined)
      setPending(null)
      setReason('')
      load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That action failed.')
    } finally {
      setBusy(false)
    }
  }

  if (!d) return <p className="py-10 text-center text-white/50">{error ?? 'Loading…'}</p>
  const features = Object.entries(d.features ?? {}).filter(([k]) => k in FEATURE_LABELS)
  return (
    <div className="space-y-5">
      <button type="button" onClick={onClose} className="text-sm text-[#7C9BFF] hover:text-white">
        ← All flagged accounts
      </button>
      <div className="flex items-center gap-3">
        <h2 className="flex-1 text-2xl font-bold">{d.name}</h2>
        <ScoreBadge score={d.score} />
      </div>
      <p className="text-sm text-white/50">
        Member since {d.memberSince ?? '—'} · {d.accountAgeDays ?? '—'} days · {d.photoCount} photos · {d.verificationStatus}
        {d.isFounder && ' · founder'} · group {d.cohort ?? '—'} ({d.cohortSize ?? 0})
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => viewProfile(uid).then(setProfile).catch(() => setError("Couldn't load the profile."))}
          className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15"
        >
          View profile (logged)
        </button>
        {ACTIONS.filter((a) => (a.id === 'restore_visibility' ? d.visibilityReduced : a.id === 'reduce_visibility' ? !d.visibilityReduced : a.id === 'dismiss' ? d.flag?.status === 'open' : a.id === 'lift_suspension' ? d.suspended : !d.suspended)).map((a) => (
          <button key={a.id} type="button" onClick={() => setPending(a.id)} className={`rounded-lg px-3 py-1.5 text-sm ${a.tone} hover:opacity-90`}>
            {a.label}
          </button>
        ))}
      </div>
      {pending && (
        <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-4">
          <p className="font-semibold">{ACTIONS.find((a) => a.id === pending)?.label} — reason (logged)</p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full rounded-lg bg-black/30 p-2 text-sm"
            placeholder="Why — e.g. same device as a banned account, copy-paste openers"
          />
          {pending === 'suspend' && (
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg bg-black/30 p-2 text-sm">
              {[30, 60, 90].map((n) => (
                <option key={n} value={n}>
                  {n} days
                </option>
              ))}
            </select>
          )}
          <div className="flex gap-2">
            <button type="button" disabled={busy || reason.trim().length < 5} onClick={() => void run()} className="rounded-lg bg-[#1B4FD8] px-3 py-1.5 text-sm disabled:opacity-50">
              {busy ? 'Saving…' : 'Confirm'}
            </button>
            <button type="button" onClick={() => setPending(null)} className="text-sm text-white/50">
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">Why it was flagged</h3>
        {d.reasons.length ? (
          <ul className="space-y-1 text-sm">
            {d.reasons.map((r) => (
              <li key={r.key} className="flex justify-between gap-3">
                <span>{r.text}</span>
                <span className="text-white/40">+{r.points}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/50">Nothing scored.</p>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">Signals (their group's typical value)</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {features.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-white/5 py-1">
              <dt className="text-white/50">{FEATURE_LABELS[k]}</dt>
              <dd>
                {fmt(v)}
                {k in d.cohortMedians && <span className="text-white/35"> ({fmt(d.cohortMedians[k])})</span>}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">Linked accounts</h3>
        {d.linked.length ? (
          <ul className="space-y-1 text-sm">
            {d.linked.map((l) => (
              <li key={l.uid} className="flex justify-between gap-2">
                <span>
                  {l.name}
                  {l.deleted && ' (deleted)'} <span className="text-white/40">· same {l.via.join(' + ')}</span>
                </span>
                {l.flagged && <ScoreBadge score={l.score} />}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/50">None in the last 90 days.</p>
        )}
      </section>

      {d.suspendedPendingReview && (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Suspended {d.suspendSource === 'auto_scam' ? 'automatically after scam reports from unlinked accounts' : ''} — pending your
          review. Suspend for 30/60/90 days to confirm, or lift the suspension.
        </p>
      )}

      {d.scamTraps.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">Sent to curated profiles (scam patterns)</h3>
          <ul className="space-y-2">
            {d.scamTraps.map((t, i) => (
              <li key={i} className="rounded-lg bg-white/5 px-3 py-2 text-sm">
                <span className="text-white/40">
                  {fmtDate(t.at)} · {t.hits.join(', ')}
                </span>
                <span className="mt-1 block italic text-white/80">“{t.excerpt}”</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.photoChecks.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">Photo checks (AI-generated · found on the web)</h3>
          <ul className="space-y-1 text-sm">
            {d.photoChecks.map((p) => (
              <li key={p.path}>
                AI {p.ai === null ? '—' : `${Math.round(p.ai * 100)}%`} · deepfake {p.deepfake === null ? '—' : `${Math.round(p.deepfake * 100)}%`} ·{' '}
                {p.web === null ? 'web not checked' : `${p.web.full} copies on ${p.web.pages} pages`}
                {p.web?.sample.map((u) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer noopener" className="ml-2 text-[#7C9BFF] underline">
                    {hostOf(u)}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.countryCheck && (
        <p className="text-sm text-white/50">
          Signup country — IP: {d.countryCheck.ip ?? 'unknown'} · phone: {d.countryCheck.phone ?? 'unknown'} · city: {d.countryCheck.city ?? 'unknown'}
        </p>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">Reports and blocks</h3>
        <p className="text-sm">
          {d.reports.total} reports from {d.reports.reporters} people ({d.reports.urgent} urgent, {d.reports.pending} pending) ·{' '}
          {d.blocksReceived} blocks
        </p>
        {Object.keys(d.reports.byCategory).length > 0 && (
          <p className="mt-1 text-sm text-white/50">
            {Object.entries(d.reports.byCategory)
              .map(([c, n]) => `${c.replace(/_/g, ' ')} ×${n}`)
              .join(' · ')}
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">Admin history</h3>
        {d.history.length ? (
          <ul className="space-y-1 text-sm text-white/70">
            {d.history.map((h, i) => (
              <li key={i}>
                {fmtDate(h.at)} · {h.action}
                {h.reason && ` — ${h.reason}`}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/50">Nothing yet.</p>
        )}
      </section>

      {profile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setProfile(null)}>
          <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-gray-900 p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-xl font-bold">
              {String(profile.profile.displayName ?? '')}
              {typeof profile.profile.age === 'number' && <span className="font-normal text-white/60">, {profile.profile.age}</span>}
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {(Array.isArray(profile.profile.photoURLs) ? (profile.profile.photoURLs as string[]) : []).map((p) => (
                <StoredImg key={p} src={p} alt="" className="aspect-square w-full rounded-lg object-cover" />
              ))}
            </div>
            {(profile.sparkBio || typeof profile.profile.bio === 'string') && (
              <p className="mt-3 text-sm text-white/80">{profile.sparkBio ?? String(profile.profile.bio)}</p>
            )}
            <button type="button" onClick={() => setProfile(null)} className="mt-4 w-full rounded-lg bg-white/10 py-2 text-sm">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function AdminTrust() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<FlagStatus | 'directory'>('open')
  const [list, setList] = useState<TrustSummary[] | null>(null)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)

  const load = useCallback(() => {
    if (tab === 'directory') return
    getTrustQueue(tab)
      .then((r) => {
        setList(r.flags)
        setError(false)
      })
      .catch(() => setError(true))
  }, [tab])
  useEffect(load, [load])

  async function search() {
    setSearching(true)
    try {
      setList((await searchUsers(q.trim())).results)
      setError(false)
    } catch {
      setError(true)
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 text-white">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-[#7C9BFF] hover:text-white">
          ← Back
        </button>
        <h1 className="text-xl font-bold">Trust & safety</h1>
      </div>
      <p className="mt-1 text-xs text-white/40">Every view and action here is logged.</p>
      {open ? (
        <div className="mt-5">
          <Detail uid={open} onClose={() => setOpen(null)} onChanged={load} />
        </div>
      ) : (
        <>
          <div className="mt-4 flex gap-2">
            {(['open', 'actioned', 'dismissed', 'directory'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTab(t)
                  setList(t === 'directory' ? [] : null)
                }}
                className={`rounded-full px-3 py-1 text-sm ${tab === t ? 'bg-white text-gray-950' : 'bg-white/10 text-white/70'}`}
              >
                {t === 'open' ? 'Flagged' : t === 'directory' ? 'Directory' : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          {tab === 'directory' && (
            <form
              className="mt-4 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void search()
              }}
            >
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Name, user id or phone"
                className="flex-1 rounded-lg bg-white/10 px-3 py-2 text-sm"
              />
              <button type="submit" disabled={q.trim().length < 2 || searching} className="rounded-lg bg-[#1B4FD8] px-4 text-sm disabled:opacity-50">
                {searching ? '…' : 'Search'}
              </button>
            </form>
          )}
          {error && <p className="mt-6 text-center text-sm text-red-400">Couldn't load. Try again.</p>}
          {list === null ? (
            <p className="mt-10 text-center text-white/50">Loading…</p>
          ) : list.length === 0 ? (
            <p className="mt-10 text-center text-white/50">{tab === 'directory' ? 'Search for an account.' : 'Nothing here.'}</p>
          ) : (
            <ul className="mt-4 divide-y divide-white/5">
              {list.map((s) => (
                <Row key={s.uid} s={s} onOpen={() => setOpen(s.uid)} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
