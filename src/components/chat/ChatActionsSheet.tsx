import { useEffect, useState } from 'react'

export type ChatAction = 'report' | 'block' | 'unmatch'

interface ChatActionsSheetProps {
  name: string
  onReport: () => void
  // Rejects on failure; the sheet shows the error and stays open.
  onEnd: (action: 'block' | 'unmatch') => Promise<void>
  onClose: () => void
  // Photo sharing with this match; absent when photos aren't possible here
  // (a curated profile, or an ended chat).
  photo?: {
    // off: never asked, declined or revoked · waiting: our request is out ·
    // incoming: they asked us · enabled: both agreed.
    state: 'off' | 'waiting' | 'incoming' | 'enabled'
    onAllow: () => void
    onRevoke: () => void
  }
}

// The chat header's ••• menu: photo sharing, Report, Block, Unmatch. Revoking
// photos, Block and Unmatch ask for confirmation first.
export default function ChatActionsSheet({ name, onReport, onEnd, onClose, photo }: ChatActionsSheetProps) {
  const [confirm, setConfirm] = useState<'block' | 'unmatch' | 'revoke' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function run(action: 'block' | 'unmatch') {
    setBusy(true)
    setError(null)
    try {
      await onEnd(action)
    } catch {
      setError(action === 'block' ? "Couldn't block. Try again." : "Couldn't unmatch. Try again.")
      setBusy(false)
    }
  }

  const option = 'w-full px-6 py-4 text-left font-medium hover:bg-white/5'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Options for ${name}`}
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-full overflow-hidden rounded-t-2xl bg-gray-900 text-white pb-[env(safe-area-inset-bottom,0px)] lg:max-w-sm lg:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {confirm === null ? (
          <div className="divide-y divide-white/5">
            {photo?.state === 'enabled' && (
              <>
                <p className="px-6 py-4 font-medium text-emerald-300">Photo sharing enabled ✓</p>
                <button type="button" onClick={() => setConfirm('revoke')} className={option}>
                  Revoke photo sharing
                </button>
              </>
            )}
            {photo?.state === 'waiting' && (
              <p className="px-6 py-4 text-white/50">Photo sharing · waiting for {name} to accept</p>
            )}
            {(photo?.state === 'off' || photo?.state === 'incoming') && (
              <button type="button" onClick={photo.onAllow} className={option}>
                Allow photo sharing
                {photo.state === 'incoming' && <span className="block text-sm font-normal text-white/50">{name} asked to share photos</span>}
              </button>
            )}
            <button type="button" onClick={onReport} className={option} autoFocus>
              Report {name}
            </button>
            <button type="button" onClick={() => setConfirm('block')} className={`${option} text-red-400`}>
              Block {name}
            </button>
            <button type="button" onClick={() => setConfirm('unmatch')} className={option}>
              Unmatch
            </button>
            <button type="button" onClick={onClose} className={`${option} text-center text-white/50`}>
              Cancel
            </button>
          </div>
        ) : confirm === 'revoke' ? (
          <div className="px-6 pt-6 pb-6">
            <p className="text-lg font-semibold">Revoke photo sharing with {name}?</p>
            <p className="mt-2 text-sm text-white/60">Neither of you can send new photos until one of you asks again and the other accepts.</p>
            <button
              type="button"
              onClick={() => photo?.onRevoke()}
              autoFocus
              className="mt-6 w-full rounded-xl bg-white/15 py-3 font-semibold text-white transition-opacity hover:opacity-90"
            >
              Revoke
            </button>
            <button type="button" onClick={() => setConfirm(null)} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
              Cancel
            </button>
          </div>
        ) : (
          <div className="px-6 pt-6 pb-6">
            <p className="text-lg font-semibold">
              {confirm === 'block'
                ? `Block ${name}? They won't be able to message you and will be removed from your matches.`
                : `End this connection with ${name}?`}
            </p>
            {confirm === 'unmatch' && (
              <p className="mt-2 text-sm text-white/60">Your conversation and any shared photos will be deleted for both of you.</p>
            )}
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            <button
              type="button"
              onClick={() => void run(confirm)}
              disabled={busy}
              autoFocus
              className={`mt-6 w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${
                confirm === 'block' ? 'bg-red-600' : 'bg-white/15'
              }`}
            >
              {busy ? (confirm === 'block' ? 'Blocking…' : 'Unmatching…') : confirm === 'block' ? 'Block' : 'Unmatch'}
            </button>
            <button
              type="button"
              onClick={() => (busy ? undefined : setConfirm(null))}
              disabled={busy}
              className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
