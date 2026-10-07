import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ProbationPanel from '../../components/admin/ProbationPanel'
import { cityStats, type CityRow, type CityStats } from '../../services/adminTools'

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
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-white/40">
              <tr>
                <th className="px-4 py-3 font-semibold">City</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Women</th>
                <th className="px-4 py-3 font-semibold">Men</th>
                <th className="px-4 py-3 text-right font-semibold">Total</th>
                <th className="px-4 py-3 text-right font-semibold">Spark+</th>
                <th className="px-4 py-3 text-right font-semibold">Elite</th>
                <th className="px-4 py-3 text-right font-semibold">New (7d)</th>
                <th className="px-4 py-3 text-right font-semibold">Last founder</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {stats.cities.map((c) => (
                <CityTableRow key={c.id} city={c} />
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
      <ProbationPanel />
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

function CityTableRow({ city: c }: { city: CityRow }) {
  const total = c.women + c.men
  return (
    <tr className={total === 0 ? 'text-white/50' : undefined}>
      <td className="px-4 py-3 font-medium text-white">
        {c.name} <span className="text-white/40">{c.state}</span>
      </td>
      <td className="px-4 py-3">
        {c.live ? (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-300">🟢 Live</span>
        ) : (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-300">🟡 Building</span>
        )}
      </td>
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
    </tr>
  )
}
