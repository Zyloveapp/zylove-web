import { useEffect, useState } from 'react'
import { cspReports, type CspDayCounts } from '../../services/adminTools'

// F-082: what the Report-Only script policy (vercel.json) would have blocked
// over the last 7 days, by directive and blocked host — counts only. A clean
// week of real traffic (only extension or bot noise) is the signal to enforce
// the policy.
export default function CspReportsPanel() {
  const [days, setDays] = useState<CspDayCounts[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    cspReports()
      .then(setDays)
      .catch(() => setError(true))
  }, [])

  const week = new Map<string, { directive: string; host: string; n: number }>()
  for (const d of days ?? []) {
    for (const c of d.counts) {
      const key = `${c.directive}|${c.host}`
      const row = week.get(key) ?? { directive: c.directive, host: c.host, n: 0 }
      row.n += c.n
      week.set(key, row)
    }
  }
  const rows = [...week.values()].sort((a, b) => b.n - a.n).slice(0, 25)
  const total = (days ?? []).reduce((s, d) => s + d.total, 0)

  return (
    <section className="mt-10">
      <h2 className="text-lg font-bold">Content Security Policy reports</h2>
      <p className="mt-1 text-sm text-white/50">
        What the report-only script policy would have blocked in the last 7 days (UTC), by directive and blocked host.
      </p>
      {error && <p className="mt-2 text-sm text-red-400">Couldn't load CSP reports.</p>}
      {days && (
        <>
          <p className="mt-3 text-sm text-white/70">
            {total.toLocaleString()} report{total === 1 ? '' : 's'} · {days.map((d) => `${d.day.slice(5)}: ${d.total}`).join(' · ')}
          </p>
          {rows.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wider text-white/40">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Directive</th>
                    <th className="px-4 py-3 font-semibold">Blocked</th>
                    <th className="px-4 py-3 text-right font-semibold">Reports</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {rows.map((r) => (
                    <tr key={`${r.directive}|${r.host}`}>
                      <td className="px-4 py-2 font-mono text-xs">{r.directive}</td>
                      <td className="px-4 py-2 font-mono text-xs">{r.host}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
