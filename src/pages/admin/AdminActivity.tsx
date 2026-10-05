import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ActivityChart from '../../components/admin/ActivityChart'
import {
  getActivity,
  runUserAction,
  type Activity,
  type ActivityQuery,
  type Mode,
  type Status,
  type Tier,
  type UserAction,
  type UserRow,
} from '../../services/adminActivity'

const REFRESH_MS = 60_000

const TIER_LABEL: Record<Tier, string> = {
  founder: 'Founder',
  elite: 'Elite',
  spark_plus: 'Spark+',
  trial: 'Trial',
  prelaunch: 'Pre-launch',
  free: 'Free',
}
const MODE_LABEL: Record<Mode, string> = { spark: 'Spark', play: 'Play', both: 'Both', none: '—' }
const STATUS_STYLE: Record<Status, string> = {
  active: 'bg-emerald-500/15 text-emerald-300',
  hidden: 'bg-white/10 text-white/60',
  suspended: 'bg-amber-500/15 text-amber-300',
  deleted: 'bg-red-500/15 text-red-300',
}

function ago(t: number | null, now: number): string {
  if (t === null) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

function updatedAgo(t: number, now: number): string {
  const sec = Math.max(0, Math.round((now - t) / 1000))
  return sec < 60 ? `${sec} second${sec === 1 ? '' : 's'} ago` : ago(t, now)
}

// "3 hours ago" within a day, else "Oct 4".
function joined(t: number | null, now: number): string {
  if (t === null) return '—'
  return now - t < 24 * 60 * 60 * 1000 ? ago(t, now) : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const compact = (n: number) => n.toLocaleString(undefined, { notation: n >= 10_000 ? 'compact' : 'standard' })

const INITIAL: ActivityQuery = { page: 0, mode: 'all', tier: 'all', activity: 'all', city: 'all', sort: 'newest' }

// /admin/activity: everyone on Zylove (bots excluded) — headline stats, a
// 30-day chart, a city breakdown and a filterable user table with actions.
export default function AdminActivity() {
  const navigate = useNavigate()
  const [query, setQuery] = useState<ActivityQuery>(INITIAL)
  const [data, setData] = useState<Activity | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [selected, setSelected] = useState<UserRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const latest = useRef(0)

  const load = useCallback((q: ActivityQuery) => {
    const id = ++latest.current
    setLoading(true)
    getActivity(q)
      .then((d) => {
        if (id !== latest.current) return
        setData(d)
        setError(false)
      })
      .catch(() => id === latest.current && setError(true))
      .finally(() => id === latest.current && setLoading(false))
  }, [])

  useEffect(() => {
    load(query)
    const refresh = setInterval(() => load(query), REFRESH_MS)
    return () => clearInterval(refresh)
  }, [query, load])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  // A filter change goes back to the first page.
  const setFilter = <K extends keyof ActivityQuery>(key: K, value: ActivityQuery[K]) =>
    setQuery((q) => ({ ...q, [key]: value, page: key === 'page' ? (value as number) : 0 }))

  const s = data?.stats
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 text-white">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-[#7C9BFF] hover:text-white">
            ← Back
          </button>
          <h1 className="text-xl font-bold">Activity dashboard</h1>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {data && <span className="text-white/40">Last updated: {updatedAgo(data.generatedAt, now)}</span>}
          <button
            type="button"
            onClick={() => load(query)}
            disabled={loading}
            className="rounded-xl border border-white/15 px-3 py-1.5 font-semibold text-white/80 hover:bg-white/5 disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {notice && (
        <p className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>
      )}
      {error && <p className="mt-4 text-sm text-red-400">Couldn't load activity{data ? ' — showing the last good data.' : '.'}</p>}
      {!data && !error && <div className="mx-auto mt-12 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />}

      {s && (
        <div className="mt-6 space-y-3">
          <StatRow
            title="Accounts"
            tiles={[
              ['Total accounts', s.accounts.total],
              ['Created today', s.accounts.today],
              ['This week', s.accounts.week],
              ['This month', s.accounts.month],
            ]}
          />
          <StatRow
            title="Engagement"
            tiles={[
              ['Active today', s.engagement.activeToday],
              ['Active this week', s.engagement.activeWeek],
              ['Avg session length', 'Not tracked'],
              ['Messages sent', s.engagement.totalMessages],
            ]}
          />
          <StatRow
            title="Conversion"
            tiles={[
              ['Completed onboarding', s.conversion.onboarded],
              ['Spark profiles', s.conversion.sparkProfiles],
              ['Play profiles', s.conversion.playProfiles],
              ['Founders', s.conversion.founders],
            ]}
          />
          <StatRow
            title="Revenue"
            tiles={[
              ['Spark+ (paying)', s.revenue.sparkPlusPaying],
              ['Elite (paying)', s.revenue.elitePaying],
              ['Trials active', s.revenue.trialActive],
              ['Trials expired, not converted', s.revenue.trialExpired],
            ]}
          />
        </div>
      )}

      {data && (
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-5">
          <h2 className="mb-3 text-sm font-semibold">Last 30 days</h2>
          <ActivityChart days={data.chart.days} signups={data.chart.signups} active={data.chart.active} />
        </section>
      )}

      {data && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold">Users</h2>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <Select
              label="Mode"
              value={query.mode}
              onChange={(v) => setFilter('mode', v as ActivityQuery['mode'])}
              options={[
                ['all', 'All modes'],
                ['spark', 'Spark only'],
                ['play', 'Play only'],
                ['both', 'Both'],
              ]}
            />
            <Select
              label="Tier"
              value={query.tier}
              onChange={(v) => setFilter('tier', v as ActivityQuery['tier'])}
              options={[['all', 'All tiers'], ...(Object.entries(TIER_LABEL) as [Tier, string][])]}
            />
            <Select
              label="Activity"
              value={query.activity}
              onChange={(v) => setFilter('activity', v as ActivityQuery['activity'])}
              options={[
                ['all', 'Any activity'],
                ['today', 'Active today'],
                ['week', 'Active this week'],
                ['inactive7', 'Inactive 7+ days'],
              ]}
            />
            <Select
              label="City"
              value={query.city}
              onChange={(v) => setFilter('city', v)}
              options={[['all', 'All cities'], ...data.cities.map((c) => [c, c] as [string, string])]}
            />
            <Select
              label="Sort"
              value={query.sort}
              onChange={(v) => setFilter('sort', v as ActivityQuery['sort'])}
              options={[
                ['newest', 'Newest'],
                ['last_active', 'Last active'],
                ['messages', 'Most messages'],
                ['tier', 'Tier'],
              ]}
            />
          </div>

          <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-white/40">
                <tr>
                  {['Name', 'Gender', 'City', 'Joined', 'Last active', 'Onboarding', 'Mode', 'Tier', 'Messages', 'Matches', 'Status'].map(
                    (h, i) => (
                      <th key={h} className={`px-4 py-3 font-semibold ${i === 8 || i === 9 ? 'text-right' : ''}`}>
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.rows.map((r) => (
                  <tr
                    key={r.uid}
                    tabIndex={0}
                    onClick={() => setSelected(r)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSelected(r))}
                    className="cursor-pointer hover:bg-white/[0.04] focus:bg-white/[0.06] focus:outline-none"
                  >
                    <td className="px-4 py-3 font-medium">{r.name}</td>
                    <td className="px-4 py-3 capitalize text-white/70">{r.gender}</td>
                    <td className="px-4 py-3 text-white/70">{r.city}</td>
                    <td className="px-4 py-3 text-white/70">{joined(r.joinedAt, now)}</td>
                    <td className="px-4 py-3 text-white/70">{ago(r.lastActiveAt, now)}</td>
                    <td className="px-4 py-3">{r.onboarded ? '✅ Complete' : '⏳ Incomplete'}</td>
                    <td className="px-4 py-3 text-white/70">{MODE_LABEL[r.mode]}</td>
                    <td className="px-4 py-3">
                      {TIER_LABEL[r.tier]}
                      {r.paying && <span className="ml-1 text-xs text-emerald-300">· paid</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{compact(r.messages)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.matches}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                    </td>
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-4 py-10 text-center text-white/50">
                      No users match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-white/50">
            <span>
              {data.total.toLocaleString()} user{data.total === 1 ? '' : 's'} · page {data.page + 1} of {data.pageCount}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFilter('page', data.page - 1)}
                disabled={data.page === 0}
                className="rounded-lg border border-white/15 px-3 py-1 hover:bg-white/5 disabled:opacity-30"
              >
                ← Prev
              </button>
              <button
                type="button"
                onClick={() => setFilter('page', data.page + 1)}
                disabled={data.page >= data.pageCount - 1}
                className="rounded-lg border border-white/15 px-3 py-1 hover:bg-white/5 disabled:opacity-30"
              >
                Next →
              </button>
            </div>
          </div>
        </section>
      )}

      {data && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold">By city</h2>
          <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-white/40">
                <tr>
                  <th className="px-4 py-3 font-semibold">City</th>
                  <th className="px-4 py-3 text-right font-semibold">Users</th>
                  <th className="px-4 py-3 text-right font-semibold">Founders</th>
                  <th className="px-4 py-3 text-right font-semibold">Spark+</th>
                  <th className="px-4 py-3 text-right font-semibold">Last signup</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.geo.map((g) => (
                  <tr key={g.city}>
                    <td className="px-4 py-3 font-medium">{g.city}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{g.users}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{g.founders}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{g.sparkPlus}</td>
                    <td className="px-4 py-3 text-right text-white/60">{joined(g.lastSignupAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-white/30">
            Launch city by saved location, else the profile's place name. Deleted accounts and bots excluded.
          </p>
        </section>
      )}

      {selected && (
        <RowActions
          row={selected}
          onClose={() => setSelected(null)}
          onDone={(message) => {
            setSelected(null)
            setNotice(message)
            load(query)
          }}
        />
      )}
    </div>
  )
}

function StatRow({ title, tiles }: { title: string; tiles: [string, number | string][] }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-white/40">{title}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
            <p className="text-xs text-white/50">{label}</p>
            <p className={`mt-1 font-semibold ${typeof value === 'number' ? 'text-2xl' : 'text-base text-white/40'}`}>
              {typeof value === 'number' ? compact(value) : value}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: [string, string][]
  onChange: (v: string) => void
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-xl border border-white/10 bg-gray-900 px-3 py-2 text-white focus:border-white/30 focus:outline-none"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
}

const CONFIRM: Partial<Record<UserAction, { title: string; body: string; button: string; danger: boolean }>> = {
  suspend: { title: 'Suspend this account?', body: "They'll be hidden everywhere until you unsuspend them.", button: 'Suspend', danger: true },
  delete: {
    title: 'Delete this account?',
    body: "Same as them deleting it: their profile is wiped, they're signed out for good, and it joins the deletion queue (restorable for 90 days if they have a phone on file).",
    button: 'Delete account',
    danger: true,
  },
}

function RowActions({ row, onClose, onDone }: { row: UserRow; onClose: () => void; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState<UserAction | null>(null)
  const [confirming, setConfirming] = useState<UserAction | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function act(action: UserAction) {
    setBusy(action)
    setMessage(null)
    try {
      const result = await runUserAction(row.uid, action)
      if (action === 'make_founder') {
        const f = result.founder
        if (f?.eligible) return onDone(`${row.name} is now ${f.cityName ?? 'a'} founder #${f.cohortNumber}.`)
        const why: Record<string, string> = {
          outside_coverage: "They're not within a launch city (or have no saved location).",
          cohort_full: "Their city's founder spots for their half are full.",
          no_profile: "They haven't finished onboarding.",
          already_assigned: 'They already were a founder.',
        }
        setMessage(why[f && !f.eligible ? f.reason : ''] ?? "Couldn't make them a founder.")
        setBusy(null)
        setConfirming(null)
        return
      }
      onDone(
        action === 'suspend' ? `${row.name} suspended.` : action === 'unsuspend' ? `${row.name} unsuspended.` : `${row.name}'s account deleted.`,
      )
    } catch (err) {
      setMessage(err instanceof Error && err.message ? err.message : 'That didn’t work. Try again.')
      setBusy(null)
      setConfirming(null)
    }
  }

  const confirm = confirming ? CONFIRM[confirming] : undefined
  const item = 'flex w-full items-center justify-between rounded-xl px-4 py-3 text-left hover:bg-white/5 disabled:opacity-40'
  const deleted = row.status === 'deleted'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="row-actions-title"
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="w-full rounded-t-2xl border border-white/10 bg-gray-950 px-4 pt-5 text-white pb-[calc(1rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-4">
        <h2 id="row-actions-title" className="px-2 text-lg font-bold">
          {row.name}
        </h2>
        <p className="px-2 font-mono text-xs text-white/40">{row.uid}</p>
        {message && <p className="mx-2 mt-3 text-sm text-amber-300">{message}</p>}

        {confirm ? (
          <div className="mt-4 px-2">
            <p className="font-semibold">{confirm.title}</p>
            <p className="mt-1 text-sm text-white/60">{confirm.body}</p>
            <button
              type="button"
              onClick={() => confirming && void act(confirming)}
              disabled={busy !== null}
              className="mt-4 w-full rounded-xl bg-red-600 py-3 font-semibold hover:bg-red-500 disabled:opacity-50"
            >
              {busy ? 'Working…' : confirm.button}
            </button>
            <button type="button" onClick={() => setConfirming(null)} disabled={busy !== null} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
              Cancel
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-1">
            <button type="button" className={item} onClick={() => window.open(`/profile/${row.uid}`, '_blank', 'noopener')}>
              View profile <span className="text-white/30">↗</span>
            </button>
            <button
              type="button"
              className={item}
              onClick={() => {
                void navigator.clipboard?.writeText(row.uid).then(() => setMessage('UID copied.'))
              }}
            >
              Copy UID
            </button>
            {row.tier !== 'founder' && !deleted && (
              <button type="button" className={item} disabled={busy !== null} onClick={() => void act('make_founder')}>
                {busy === 'make_founder' ? 'Checking spots…' : '✦ Make founder'}
              </button>
            )}
            {!deleted &&
              (row.status === 'suspended' ? (
                <button type="button" className={item} disabled={busy !== null} onClick={() => void act('unsuspend')}>
                  {busy === 'unsuspend' ? 'Working…' : 'Unsuspend account'}
                </button>
              ) : (
                <button type="button" className={`${item} text-amber-300`} disabled={busy !== null} onClick={() => setConfirming('suspend')}>
                  Suspend account
                </button>
              ))}
            {!deleted && (
              <button type="button" className={`${item} text-red-300`} disabled={busy !== null} onClick={() => setConfirming('delete')}>
                Delete account
              </button>
            )}
            <button type="button" onClick={onClose} disabled={busy !== null} className="mt-1 w-full py-2 text-sm text-white/50 hover:text-white">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
