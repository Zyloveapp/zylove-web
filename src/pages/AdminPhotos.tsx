import { useCallback, useEffect, useState } from 'react'
import { flagReason, listPendingPhotos, reviewPendingPhoto, type PendingPhoto } from '../services/adminPhotos'

function submitted(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleString()
}

// Internal: the queue of photos moderation held back, oldest first.
export default function AdminPhotos() {
  const [photos, setPhotos] = useState<PendingPhoto[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchQueue = useCallback(() => {
    listPendingPhotos()
      .then(setPhotos)
      .catch(() => setLoadError(true))
  }, [])

  useEffect(() => {
    fetchQueue()
  }, [fetchQueue])

  function refresh() {
    setLoadError(false)
    setPhotos(null)
    fetchQueue()
  }

  async function decide(photo: PendingPhoto, action: 'approve' | 'reject') {
    setBusy(photo.url)
    setError(null)
    try {
      await reviewPendingPhoto(photo, action)
      setPhotos((list) => list?.filter((p) => p.url !== photo.url) ?? null)
    } catch {
      setError(`Couldn't ${action} that photo. Refresh and try again.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 text-white">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">Photo review</h1>
        <button
          type="button"
          onClick={refresh}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/70 hover:bg-white/5"
        >
          Refresh
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {loadError ? (
        <p className="text-white/60">Couldn't load the queue.</p>
      ) : photos === null ? (
        <p className="text-white/50">Loading…</p>
      ) : photos.length === 0 ? (
        <p className="text-white/50">Nothing waiting for review.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/5 text-xs uppercase tracking-wide text-white/40">
              <tr>
                <th className="px-3 py-2">Photo</th>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Mode</th>
                <th className="px-3 py-2">Submitted</th>
                <th className="px-3 py-2">Flag</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {photos.map((p) => (
                <tr key={p.url} className="align-top">
                  <td className="px-3 py-2">
                    <a href={p.url} target="_blank" rel="noreferrer">
                      <img src={p.url} alt="" className="h-24 w-20 rounded object-cover" />
                    </a>
                  </td>
                  <td className="px-3 py-2">
                    <p className="font-medium">{p.displayName || '—'}</p>
                    <p className="font-mono text-xs text-white/40">{p.uid}</p>
                  </td>
                  <td className="px-3 py-2">
                    <span className={p.mode === 'play' ? 'text-red-400' : 'text-[#6B8FFF]'}>{p.mode}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-white/60">{submitted(p.flaggedAt)}</td>
                  <td className="px-3 py-2 text-white/60">{flagReason(p.reason)}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => decide(p, 'approve')}
                        disabled={busy !== null}
                        className="whitespace-nowrap rounded-lg bg-emerald-600 px-3 py-1.5 font-medium disabled:opacity-40"
                      >
                        ✓ Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(p, 'reject')}
                        disabled={busy !== null}
                        className="whitespace-nowrap rounded-lg bg-red-600 px-3 py-1.5 font-medium disabled:opacity-40"
                      >
                        ✗ Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
