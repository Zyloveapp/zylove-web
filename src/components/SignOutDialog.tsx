import { useEffect, useState } from 'react'
import { getBackupInfo } from '../services/keyBackup'
import { signOutAndWipe } from '../services/signOut'

// Settings → Sign out (Stage B). Signing out clears this browser of the
// account; the one choice is whether to keep the chat key here ("Remember
// this device"). Without a chat PIN backup, forgetting it would lose their
// messages for good, so that's said plainly and remembering starts ticked.
export default function SignOutDialog({ onClose }: { onClose: () => void }) {
  const [backup, setBackup] = useState<boolean | null>(null)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    getBackupInfo().then(
      (b) => {
        if (cancelled) return
        setBackup(b.exists)
        setRemember(!b.exists)
      },
      () => {
        if (cancelled) return
        setBackup(false)
        setRemember(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 px-4" role="dialog" aria-modal="true" aria-labelledby="signout-title">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-gray-900 p-6 text-white">
        <h2 id="signout-title" className="text-lg font-bold">
          Sign out
        </h2>
        <p className="mt-2 text-sm text-white/60">This clears your Zylove data from this browser, including any unsaved drafts.</p>
        {backup === null ? (
          <div className="mt-4 h-12 animate-pulse rounded-xl bg-white/5" />
        ) : (
          <>
            <label className="mt-4 flex items-start gap-3 text-sm">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-1" />
              <span>
                <span className="block font-medium">Remember this device</span>
                <span className="block text-white/50">Keep your chat key here, so you can read your messages next time without your chat PIN.</span>
              </span>
            </label>
            {!backup && !remember && (
              <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                You haven't set a chat PIN. Without it, forgetting this device's chat key means you won't be able to read your past
                messages anywhere. Set one in Settings → Chat PIN first, or keep this device remembered.
              </p>
            )}
          </>
        )}
        <div className="mt-6 flex gap-3">
          <button type="button" onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm text-white/70 hover:bg-white/5">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || backup === null}
            onClick={() => {
              setBusy(true)
              void signOutAndWipe({ keepChatKey: remember })
            }}
            className="flex-1 rounded-xl bg-red-500/90 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>
    </div>
  )
}
