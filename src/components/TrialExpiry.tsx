import { useEffect, useState } from 'react'
import { signOutAndWipe } from '../services/signOut'
import { SUPPORT_EMAIL } from '../services/errors'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import { useSubscriptionStore } from '../store/subscriptionStore'
import { isPlayOnlyUser } from '../services/playOnboarding'
import { deleteAccount } from '../services/profileDeletion'
import { ConfirmModal } from './DeleteProfileControls'
import { useBilling } from './PaywallGate'
import LockedPlayConnections from './matches/LockedPlayConnections'

// Trial over and no plan. Stage C (freemium): shown once, then they carry
// on with Free (Explore, matching and chat, 10 likes a day…) and paid
// features show their own upgrade prompts. Play-only accounts are the
// exception — Free has no Play — so for them it stays until they subscribe,
// sign out or delete. /upgrade sits outside the app layout, so Checkout's
// return page is never covered.
export default function TrialExpiry() {
  const uid = useAuthStore((s) => s.user?.uid) ?? null
  const expired = useSubscriptionStore((s) => s.uid === uid && s.tier === 'free' && s.trialEnded)
  const mode = useModeStore((s) => s.mode)
  const setMode = useModeStore((s) => s.setMode)
  const { pending, error, checkout } = useBilling()
  const [playOnly, setPlayOnly] = useState<{ uid: string; value: boolean } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Safety stays reachable while everything else is locked (Stage 2).
  const [safety, setSafety] = useState(false)
  const seenKey = uid ? `zylove_trial_ended_seen_${uid}` : ''
  const [dismissed, setDismissed] = useState(() => {
    try {
      return !!seenKey && localStorage.getItem(seenKey) === '1'
    } catch {
      return false
    }
  })
  const continueFree = () => {
    try {
      localStorage.setItem(seenKey, '1')
    } catch {
      // shown again next time — harmless
    }
    setDismissed(true)
  }

  useEffect(() => {
    if (!uid || !expired) return
    let cancelled = false
    isPlayOnlyUser(uid)
      .catch(() => false)
      .then((value) => {
        if (!cancelled) setPlayOnly({ uid, value })
      })
    return () => {
      cancelled = true
    }
  }, [uid, expired])

  if (!uid || !expired) return null
  const known = playOnly?.uid === uid
  const eliteOnly = known && (playOnly.value || mode === 'play')
  // Spark users carry on with Free once they've seen this.
  if (known && !playOnly.value && dismissed) return null

  async function confirmAccountDeletion() {
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteAccount()
      await signOutAndWipe({ keepChatKey: 'ifNoBackup' })
      // signOutAndWipe loads /login itself (a fresh page).
    } catch {
      setDeleteError("Couldn't delete your account. Try again.")
      setDeleting(false)
    }
  }

  const option = 'w-full rounded-xl py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60'
  return (
    <div
      className="fixed inset-0 z-[58] flex items-center justify-center bg-gray-950/95 px-4 backdrop-blur"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trial-expiry-title"
    >
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-gray-900 px-6 py-8 text-center text-white shadow-xl">
        <h2 id="trial-expiry-title" className="text-xl font-bold">
          Your free trial has ended.
        </h2>
        <p className="mt-2 text-sm text-white/60">
          {known && playOnly.value
            ? 'Play is part of Elite. Subscribe to keep your access.'
            : "You're on Free now: Explore, matching and chat, 10 likes a day. Upgrade to see who liked you, the full compatibility report and more."}
        </p>

        {!known ? (
          <div className="mx-auto mt-8 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        ) : (
          <div className="mt-6 space-y-3">
            {!eliteOnly && (
              <button type="button" onClick={() => void checkout('spark_plus')} disabled={pending !== null} className={`${option} bg-[#1B4FD8]`}>
                {pending === 'spark_plus' ? 'Taking you to checkout…' : '✦ Subscribe to Spark+ — $14.99/mo'}
              </button>
            )}
            <button type="button" onClick={() => void checkout('elite')} disabled={pending !== null} className={`${option} bg-[#E03131]`}>
              {pending === 'elite' ? 'Taking you to checkout…' : '🔥 Subscribe to Elite — $30/mo'}
            </button>
            {!playOnly.value && (
              <button
                type="button"
                onClick={() => {
                  if (mode === 'play') setMode('spark')
                  continueFree()
                }}
                disabled={pending !== null}
                className="w-full rounded-xl border border-white/20 py-3 font-semibold text-white hover:bg-white/10"
              >
                Continue with Free
              </button>
            )}
            {error && <p className="text-sm text-red-400">{error}</p>}
            {/* Never a trap: they can always leave and come back later. */}
            <button
              type="button"
              onClick={() => void signOutAndWipe({ keepChatKey: 'ifNoBackup' })}
              disabled={pending !== null}
              className="w-full rounded-xl border border-white/15 py-3 font-semibold text-white/80 hover:bg-white/10"
            >
              Sign out
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={pending !== null}
              className="w-full py-2 text-sm text-white/50 hover:text-white"
            >
              Not for me — delete my account
            </button>
            <button
              type="button"
              onClick={() => setSafety((v) => !v)}
              aria-expanded={safety}
              className="w-full py-1 text-sm text-white/50 hover:text-white"
            >
              Report or block a Play connection
            </button>
            {safety && (
              <div className="-mx-4 text-left">
                <LockedPlayConnections showEmpty />
              </div>
            )}
          </div>
        )}
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Delete your account?"
          body={`Your Spark profile, Play profile, matches and messages come down right away. Changed your mind? Email ${SUPPORT_EMAIL} within 90 days and we can restore your account — after that it's permanently deleted.`}
          confirm="Delete my account"
          typeToConfirm="DELETE"
          busy={deleting}
          error={deleteError}
          onConfirm={() => void confirmAccountDeletion()}
          onCancel={() => {
            setConfirmDelete(false)
            setDeleteError(null)
          }}
        />
      )}
    </div>
  )
}
