import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import CspReportsPanel from '../../components/admin/CspReportsPanel'
import ProbationPanel from '../../components/admin/ProbationPanel'
import { cityStats, setCityStatus, type CityRow, type CityStats, type CityStatus } from '../../services/adminTools'
import { friendlyError } from '../../services/errors'

const REFRESH_MS = 60_000

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s} second${s === 1 ? '' : 's'} ago`
  const m = Math.round(s / 60)
  return `${m} minute${m === 1 ? '' : 's'} ago`
}

function shortDate(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// /admin/cities: founding-circle progress and members per launch city,
// refreshed every minute. Most founders first.
export default function AdminCities() {
  const navigate = useNavigate()
  const [stats, setStats] = useState<CityStats | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const inFlight = useRef(false)

  const load = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    cityStats()
      .then((s) => {
        setStats(s)
        setError(false)
      })
      .catch(() => setError(true))
      .finally(() => {
        inFlight.current = false
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    load()
    const refresh = setInterval(load, REFRESH_MS)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(refresh)
      clearInterval(tick)
    }
  }, [load])

  // The city status change waiting for confirmation.
  const [pending, setPending] = useState<{ city: CityRow; to: CityStatus } | null>(null)

  const t = stats?.totals
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 text-white">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-[#7C9BFF] hover:text-white">
            ← Back
          </button>
          <h1 className="text-xl font-bold">City dashboard</h1>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {stats && <span className="text-white/40">Last updated: {ago(stats.generatedAt, now)}</span>}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-xl border border-white/15 px-3 py-1.5 font-semibold text-white/80 hover:bg-white/5 disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-red-400">Couldn't load city stats{stats ? ' — showing the last good data.' : '.'}</p>}
      {!stats && !error && <div className="mx-auto mt-12 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />}

      {t && (
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Total founders" value={`${t.founders.toLocaleString()} of ${t.capacity.toLocaleString()}`} />
          <Stat label="Subscribers (Spark+ & Elite)" value={t.subscribers.toLocaleString()} note={`${t.paying} paying through Stripe`} />
          <Stat
            label="Active users"
            value={t.activeUsers.toLocaleString()}
            note={`${t.outsideCities} outside every launch city or without a location`}
          />
        </div>
      )}

      {stats && (
        <div className="mt-6 overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-white/40">
              <tr>
                <th className="px-4 py-3 font-semibold">City</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 text-right font-semibold">Waitlist</th>
                <th className="px-4 py-3 text-right font-semibold">Founder interest</th>
                <th className="px-4 py-3 text-right font-semibold">Members</th>
                <th className="px-4 py-3 font-semibold">Women</th>
                <th className="px-4 py-3 font-semibold">Men</th>
                <th className="px-4 py-3 text-right font-semibold">Total</th>
                <th className="px-4 py-3 text-right font-semibold">Spark+</th>
                <th className="px-4 py-3 text-right font-semibold">Elite</th>
                <th className="px-4 py-3 text-right font-semibold">New (7d)</th>
                <th className="px-4 py-3 text-right font-semibold">Last founder</th>
                <th className="px-4 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {stats.cities.map((c) => (
                <CityTableRow key={c.id} city={c} onChange={(to) => setPending({ city: c, to })} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {stats && (
        <p className="mt-3 text-xs text-white/30">
          Elite includes complimentary Elite (women and other non-male identities, founders). Cities by members' saved
          location; bots excluded.
        </p>
      )}
      {pending && (
        <ConfirmStatus
          city={pending.city}
          to={pending.to}
          onClose={() => setPending(null)}
          onDone={() => {
            setPending(null)
            load()
          }}
        />
      )}
      <ProbationPanel />
      <CspReportsPanel />
    </div>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-white/40">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {note && <p className="mt-1 text-xs text-white/40">{note}</p>}
    </div>
  )
}

function Progress({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-white/70">
        {value} / {max}
      </span>
    </div>
  )
}

function CityTableRow({ city: c, onChange }: { city: CityRow; onChange: (to: CityStatus) => void }) {
  const total = c.women + c.men
  return (
    <tr className={total === 0 ? 'text-white/50' : undefined}>
      <td className="px-4 py-3 font-medium text-white">
        {c.name} <span className="text-white/40">{c.state}</span>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={c.status} />
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{c.waitlist}</td>
      <td className="px-4 py-3 text-right tabular-nums">{c.founderInterest}</td>
      <td className="px-4 py-3 text-right tabular-nums">{c.members}</td>
      <td className="px-4 py-3">
        <Progress value={c.women} max={c.target} color="bg-[#E03131]" />
      </td>
      <td className="px-4 py-3">
        <Progress value={c.men} max={c.target} color="bg-[#1B4FD8]" />
      </td>
      <td className="px-4 py-3 text-right font-semibold tabular-nums text-white">
        {total} / {c.target * 2}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{c.sparkPlus}</td>
      <td className="px-4 py-3 text-right tabular-nums">{c.elite}</td>
      <td className="px-4 py-3 text-right tabular-nums">{c.newSignups7d}</td>
      <td className="px-4 py-3 text-right text-white/60">{shortDate(c.lastFounderAt)}</td>
      <td className="px-4 py-3">
        <div className="flex gap-2">
          {ACTIONS[c.status].map((a) => (
            <button
              key={a.to}
              type="button"
              onClick={() => onChange(a.to)}
              className="rounded-lg border border-white/15 px-2 py-1 text-xs font-semibold text-white/80 hover:bg-white/5"
            >
              {a.label}
            </button>
          ))}
        </div>
      </td>
    </tr>
  )
}

// Austin-only launch (functions/src/cityStatus.ts).
const STATUS_LABEL: Record<CityStatus, { text: string; className: string }> = {
  locked: { text: '🔒 Locked', className: 'bg-white/10 text-white/60' },
  founding: { text: '🌱 Founding', className: 'bg-amber-500/15 text-amber-300' },
  live: { text: '✅ Live', className: 'bg-emerald-500/15 text-emerald-300' },
}

function StatusBadge({ status }: { status: CityStatus }) {
  const s = STATUS_LABEL[status]
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${s.className}`}>{s.text}</span>
}

const ACTIONS: Record<CityStatus, { to: CityStatus; label: string }[]> = {
  locked: [
    { to: 'founding', label: 'Unlock' },
    { to: 'live', label: 'Go live' },
  ],
  founding: [
    { to: 'live', label: 'Go live' },
    { to: 'locked', label: 'Lock' },
  ],
  live: [{ to: 'locked', label: 'Lock' }],
}

const CONFIRM: Record<CityStatus, { title: (city: string) => string; body: string; button: string }> = {
  founding: {
    title: (city) => `Unlock ${city}?`,
    body: 'Sign-ups open with the founder circle and AI profiles. Everyone waiting for this city is let in and sent an "account active" text. The first in its founder line get a 72-hour head start on founding spots.',
    button: 'Unlock',
  },
  live: {
    title: (city) => `Take ${city} live?`,
    body: "Full launch: AI profiles are retired from this city's decks and chats, and free trials start. This can't be undone back to founding.",
    button: 'Go live',
  },
  locked: {
    title: (city) => `Lock ${city}?`,
    body: 'New sign-ups here go to the waitlist. Existing members keep their profiles, matches and chats.',
    button: 'Lock',
  },
}

function ConfirmStatus({ city, to, onClose, onDone }: { city: CityRow; to: CityStatus; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const c = CONFIRM[to]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await setCityStatus(city.id, to)
      onDone()
    } catch (err) {
      setError(friendlyError(err, "Couldn't change the city's status."))
      setBusy(false)
    }
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="city-status-title"
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
    >
      <div className="w-full rounded-t-2xl border border-white/10 bg-gray-950 p-6 text-white lg:max-w-sm lg:rounded-2xl">
        <h2 id="city-status-title" className="text-lg font-bold">
          {c.title(city.name)}
        </h2>
        <p className="mt-2 text-sm text-white/60">{c.body}</p>
        {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className="mt-5 w-full rounded-xl bg-red-600 py-3 font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Saving…' : c.button}
        </button>
        <button type="button" disabled={busy} onClick={onClose} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
          Cancel
        </button>
      </div>
    </div>
  )
}
