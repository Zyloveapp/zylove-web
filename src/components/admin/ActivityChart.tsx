import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

// Two daily series over the same days on one axis: new signups (cobalt) and
// active users (red). Plain SVG. Hover or arrow keys move a crosshair with a
// tooltip listing both values; "Show as table" lists every day.
// Colors checked for the dark surface (contrast ≥ 3:1, CVD-safe as a pair).

const SERIES = [
  { key: 'signups', label: 'New signups', color: '#4F7CFF' },
  { key: 'active', label: 'Active users', color: '#E03131' },
] as const

const HEIGHT = 220
const PAD = { top: 16, right: 92, bottom: 28, left: 32 }

function niceMax(v: number): number {
  if (v <= 4) return 4
  const step = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step
  return 10 * step
}

const shortDay = (key: string) =>
  new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export default function ActivityChart({ days, signups, active }: { days: string[]; signups: number[]; active: number[] }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [asTable])

  const values = { signups, active }
  const n = days.length
  const max = niceMax(Math.max(1, ...signups, ...active))
  const plotW = width - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max].filter((t) => Number.isInteger(t))
  // ~5 date labels, always including the last day.
  const labelEvery = Math.max(1, Math.ceil(n / 5))

  function indexAt(clientX: number): number | null {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect || n === 0) return null
    const rel = (clientX - rect.left - PAD.left) / plotW
    return Math.min(n - 1, Math.max(0, Math.round(rel * (n - 1))))
  }

  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    setHover((h) => Math.min(n - 1, Math.max(0, (h ?? n - 1) + (e.key === 'ArrowRight' ? 1 : -1))))
  }

  const tipLeft = hover !== null ? Math.min(Math.max(x(hover) - 70, 4), width - 148) : 0

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4 text-xs text-white/60">
          {SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} aria-hidden />
              {s.label}
            </span>
          ))}
        </div>
        <button type="button" onClick={() => setAsTable((t) => !t)} className="text-xs text-white/50 underline hover:text-white/80">
          {asTable ? 'Show as chart' : 'Show as table'}
        </button>
      </div>

      {asTable ? (
        <div className="max-h-72 overflow-y-auto rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-900 text-xs uppercase tracking-wider text-white/40">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Day</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="px-3 py-2 text-right font-semibold">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {[...days].reverse().map((d, ri) => {
                const i = n - 1 - ri
                return (
                  <tr key={d}>
                    <td className="px-3 py-1.5 text-white/70">{shortDay(d)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{signups[i]}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{active[i]}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrapRef} className="relative">
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`New signups and active users per day, last ${n} days`}
            tabIndex={0}
            onKeyDown={onKey}
            onFocus={() => setHover((h) => h ?? n - 1)}
            onBlur={() => setHover(null)}
            onPointerMove={(e: PointerEvent<SVGSVGElement>) => setHover(indexAt(e.clientX))}
            onPointerLeave={() => setHover(null)}
            className="block touch-none outline-none focus-visible:ring-2 focus-visible:ring-white/30"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-white/40 text-[11px] tabular-nums">
                  {t.toLocaleString()}
                </text>
              </g>
            ))}
            {days.map((d, i) =>
              i % labelEvery === 0 || i === n - 1 ? (
                <text key={d} x={x(i)} y={HEIGHT - 8} textAnchor="middle" className="fill-white/40 text-[11px]">
                  {shortDay(d)}
                </text>
              ) : null,
            )}
            {hover !== null && (
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
            )}
            {SERIES.map((s) => {
              const vs = values[s.key]
              const path = vs.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
              const last = vs[n - 1] ?? 0
              return (
                <g key={s.key}>
                  <path d={path} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {/* End dot with a surface ring, then a direct end label. */}
                  <circle cx={x(n - 1)} cy={y(last)} r={4} fill={s.color} stroke="#111827" strokeWidth={2} />
                  {hover !== null && <circle cx={x(hover)} cy={y(vs[hover])} r={4} fill={s.color} stroke="#111827" strokeWidth={2} />}
                </g>
              )
            })}
            {(() => {
              // End labels: nudged apart only when the two ends nearly touch.
              const ys = SERIES.map((s) => y(values[s.key][n - 1] ?? 0))
              const gap = Math.abs(ys[0] - ys[1])
              const offset = gap < 14 ? (14 - gap) / 2 : 0
              return SERIES.map((s, i) => {
                // Higher line's label goes up; on a tie, the first series does.
                const dir = ys[i] < ys[1 - i] || (ys[i] === ys[1 - i] && i === 0) ? -1 : 1
                return (
                  <text key={s.key} x={x(n - 1) + 10} y={ys[i] + dir * offset} dominantBaseline="middle" className="fill-white/70 text-[11px]">
                    {values[s.key][n - 1] ?? 0} {s.key === 'signups' ? 'signups' : 'active'}
                  </text>
                )
              })
            })()}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-1 w-36 rounded-lg border border-white/10 bg-gray-900/95 px-3 py-2 text-xs shadow-lg"
              style={{ left: tipLeft }}
              role="status"
            >
              <p className="mb-1 text-white/50">{shortDay(days[hover])}</p>
              {SERIES.map((s) => (
                <p key={s.key} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-white/60">
                    <span className="h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
                    {s.label}
                  </span>
                  <span className="font-semibold tabular-nums text-white">{values[s.key][hover]}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="mt-2 text-xs text-white/30">
        Active = sent a chat message that day, or that was the last day they opened the app (only the latest visit is
        stored, so earlier days undercount). Central time.
      </p>
    </div>
  )
}
