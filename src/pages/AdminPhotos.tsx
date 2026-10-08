import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { flagReason, listPendingPhotos, reviewPendingPhoto, type PendingPhoto } from '../services/adminPhotos'
import StoredImg from '../components/StoredImg'
import { usePhotoUrl } from '../hooks/usePhotoUrl'

// The thumbnail, linking to the full-size photo (a short-lived URL).
function FullSizeLink({ photo }: { photo: string }) {
  const { url } = usePhotoUrl(photo)
  return (
    <a href={url ?? undefined} target="_blank" rel="noreferrer">
      <StoredImg src={photo} alt="" className="h-24 w-20 rounded object-cover" />
    </a>
  )
}

// A scam-blocklist hold: the banned account it matched, when and why it was
// banned, and how close the match is.
function BlocklistMatch({ m }: { m: NonNullable<PendingPhoto['blocklistMatch']> }) {
  const who = m.name || m.uid
  return (
    <div data-testid="blocklist-match" className="mt-1.5 space-y-0.5 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2 py-1.5 text-xs">
      <p className="text-amber-200">
        {m.closeness}
        {m.more > 0 && <span className="text-white/50"> · and {m.more} more</span>}
      </p>
      <p className="text-white/70">
        Matched{' '}
        {m.onRecord ? (
          <Link to={`/admin/trust?uid=${encodeURIComponent(m.uid)}`} className="text-[#7C9BFF] underline-offset-2 hover:underline">
            {who}
          </Link>
        ) : (
          <span>{who}</span>
        )}
        {m.name && <span className="block break-all font-mono text-[11px] text-white/40">{m.uid}</span>}
      </p>
      <p className="text-white/50">
        {m.bannedAt !== null ? `Banned ${new Date(m.bannedAt).toLocaleDateString()} · ` : ''}
        {m.why}
      </p>
    </div>
  )
}

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
        // A grid, not a table: long ids and flag text wrap and the actions
        // stack, so it fits a laptop-width window (no sideways scrolling);
        // on a phone each photo is its own card.
        <div className="rounded-xl border border-white/10">
          <div className="hidden grid-cols-[auto_minmax(0,1.4fr)_auto_minmax(0,1fr)_auto] gap-4 bg-white/5 px-3 py-2 text-xs uppercase tracking-wide text-white/40 md:grid">
            <span>Photo</span>
            <span>User</span>
            <span>Mode · submitted</span>
            <span>Flag</span>
            <span className="sr-only">Actions</span>
          </div>
          <ul className="divide-y divide-white/10">
            {photos.map((p) => (
              <li
                key={p.url}
                className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-3 py-3 text-sm md:grid-cols-[auto_minmax(0,1.4fr)_auto_minmax(0,1fr)_auto] md:items-start"
              >
                <div className="row-span-3 md:row-span-1">
                  <FullSizeLink photo={p.url} />
                </div>
                <div className="min-w-0">
                  <p className="font-medium">{p.displayName || '—'}</p>
                  <p className="break-all font-mono text-xs text-white/40">{p.uid}</p>
                </div>
                <p className="text-white/60">
                  <span className={p.mode === 'play' ? 'text-red-400' : 'text-[#6B8FFF]'}>{p.mode}</span>
                  <span className="block whitespace-nowrap text-xs">{submitted(p.flaggedAt)}</span>
                </p>
                <div className="min-w-0 break-words text-white/60">
                  <p>{flagReason(p.reason)}</p>
                  {p.blocklistMatch && <BlocklistMatch m={p.blocklistMatch} />}
                </div>
                <div className="col-span-2 flex gap-2 md:col-span-1 md:flex-col">
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
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
