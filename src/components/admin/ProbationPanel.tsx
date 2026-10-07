import { useEffect, useState } from 'react'
import { getProbation, setProbation, type ProbationCity } from '../../services/adminTrust'

// T&S Phase 2 — the per-city probation switch (functions/src/probation.ts).
// Off by default. On: accounts in that city younger than `days` get at most
// `likesPerDay` likes a day and can't exchange chat photos. Each change
// needs a reason and is logged.
export default function ProbationPanel() {
  const [cities, setCities] = useState<ProbationCity[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<ProbationCity | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () =>
    getProbation()
      .then((r) => setCities(r.cities))
      .catch(() => setError("Couldn't load the probation switches."))
  useEffect(() => {
    void load()
  }, [])

  async function save() {
    if (!editing) return
    setBusy(true)
    setError(null)
    try {
      await setProbation(editing.cityId, !editing.enabled, reason.trim())
      setEditing(null)
      setReason('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That change failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10">
      <h2 className="text-lg font-bold">New-account probation</h2>
      <p className="mt-1 text-sm text-white/50">
        Off by default. When on for a city, accounts there younger than 7 days get 5 likes a day and can't share chat photos.
      </p>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {cities && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {cities.map((c) => (
            <li key={c.cityId}>
              <button
                type="button"
                onClick={() => setEditing(c)}
                aria-pressed={c.enabled}
                className={`rounded-full border px-3 py-1 text-sm ${c.enabled ? 'border-amber-500/50 bg-amber-500/15 text-amber-200' : 'border-white/10 text-white/60 hover:text-white'}`}
              >
                {c.name}: {c.enabled ? 'on' : 'off'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <div className="mt-3 space-y-2 rounded-xl border border-white/10 bg-white/5 p-4">
          <p className="text-sm">
            Turn probation <strong>{editing.enabled ? 'off' : 'on'}</strong> for {editing.name}?
          </p>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (logged)"
            aria-label="Reason"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || reason.trim().length < 5}
              className="rounded-lg bg-[#1B4FD8] px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
            >
              Confirm
            </button>
            <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-3 py-1.5 text-sm text-white/60">
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
