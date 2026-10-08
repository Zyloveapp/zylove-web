import { useEffect, useState } from 'react'
import { signOutAndWipe } from '../services/signOut'
import { subscribeAccountView } from '../services/subscription'
import { useNavigate } from 'react-router-dom'
import { useModeStore } from '../store/modeStore'
import { deleteAccount, deletePlayProfile, deleteSparkProfile } from '../services/profileDeletion'
import { setVisibility } from '../services/visibility'
import { SUPPORT_EMAIL } from '../services/errors'

type Pending = 'profile' | 'account' | null

// A founder about to delete their account or Spark profile is first offered
// hiding instead.
type FounderWarning = 'profile' | 'account' | null

interface FounderInfo {
  city: string
  badge: string
}

function FounderWarningModal({
  founder,
  what,
  busy,
  error,
  onHide,
  onDelete,
  onCancel,
}: {
  founder: FounderInfo
  what: 'profile' | 'account'
  busy: boolean
  error: string | null
  onHide: () => void
  onDelete: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])
  const article = /^[aeiou]/i.test(founder.city) ? 'an' : 'a'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="founder-warning-title"
    >
      <div className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
        <h2 id="founder-warning-title" className="text-xl font-bold">
          ⚠ You're {article} {founder.city} Founder.
        </h2>
        {what === 'account' ? (
          <div className="mt-3 space-y-3 text-sm text-white/60">
            <p>
              Deleting your account ends your {founder.badge} status and your free Elite access.
            </p>
            <p>You can hide your account instead — your founder status stays safe and you can come back anytime.</p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-white/60">
            Deleting your Spark profile removes your founder status. Hide your account instead to preserve it.
          </p>
        )}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <button
          type="button"
          onClick={onHide}
          disabled={busy}
          autoFocus
          className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Hiding…' : 'Hide my account instead'}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="mt-2 w-full rounded-xl border border-red-500/40 py-3 font-semibold text-red-400 hover:bg-red-500/10 disabled:opacity-40"
        >
          Delete anyway
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
          Cancel
        </button>
      </div>
    </div>
  )
}

// Matches Privacy §7 (recovery record, messages on deletion) and the
// billing note (F-068, F-076).
const ACCOUNT_DELETE_BODY = [
  'Your Spark and Play profiles and your matches come down right away, and your chats end. The people you were talking to keep a read-only copy of each chat, shown as "Deleted User", until it is permanently deleted within 12 months.',
  `Changed your mind? Email ${SUPPORT_EMAIL} within 90 days and we can restore your account. We keep a recovery record (your phone number, name, birthday, gender, pronouns, bio, photo links and moderation status) for 18 months — for a banned account, as long as the ban stands.`,
  'Paying for Spark+ or Elite? Deleting your account doesn\'t cancel it — cancel first under Upgrade → Manage subscription.',
].join('\n\n')

const COPY = {
  spark: {
    row: 'Delete Spark profile',
    rowSub: 'Remove your Spark profile. Your Play profile stays untouched.',
    title: 'Delete your Spark profile?',
    body: 'This removes your Spark profile permanently. Your Play profile and account stay active.',
    confirm: 'Delete Spark profile',
  },
  play: {
    row: 'Delete Play profile',
    rowSub: 'Remove your Play profile. Your Spark profile stays untouched.',
    title: 'Delete your Play profile?',
    body: 'This removes your Play profile permanently. Your Spark profile and account stay active. You can set up a new Play profile anytime.',
    confirm: 'Delete Play profile',
  },
} as const

export function ConfirmModal({
  title,
  body,
  confirm,
  typeToConfirm,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirm: string
  typeToConfirm?: string
  busy: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])
  const ready = !typeToConfirm || typed.trim() === typeToConfirm

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-title"
    >
      <div className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
        <h2 id="delete-title" className="text-xl font-bold">
          {title}
        </h2>
        <p className="mt-2 whitespace-pre-line text-sm text-white/60">{body}</p>
        {typeToConfirm && (
          <label className="mt-4 block">
            <span className="mb-1 block text-xs text-white/50">Type {typeToConfirm} to confirm</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              autoCapitalize="characters"
              autoComplete="off"
              className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-white focus:border-red-400/60 focus:outline-none"
            />
          </label>
        )}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <button
          type="button"
          onClick={onConfirm}
          disabled={!ready || busy}
          className="mt-6 w-full rounded-xl bg-red-600 py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Deleting…' : confirm}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// Settings → Account: delete this mode's profile, or the whole account.
export default function DeleteProfileControls({ uid }: { uid: string }) {
  const navigate = useNavigate()
  const mode = useModeStore((s) => s.mode)
  const setMode = useModeStore((s) => s.setMode)
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [founder, setFounder] = useState<{ uid: string; info: FounderInfo | null } | null>(null)
  const [warning, setWarning] = useState<FounderWarning>(null)
  const [hidden, setHidden] = useState(false)
  const copy = COPY[mode]

  useEffect(() => {
    if (!uid) return
    // The account view: the public doc plus private/account, where founder
    // status and the thread summary live (Stage B).
    return subscribeAccountView(
      uid,
      (d) => {
        const isFounder = d.isFounder === true && d.founderStatus !== 'revoked'
        const city = typeof d.founderCity === 'string' && d.founderCity ? d.founderCity : 'Austin'
        const badge = typeof d.founderBadge === 'string' && d.founderBadge ? d.founderBadge : `${city} Founder`
        setFounder({ uid, info: isFounder ? { city, badge } : null })
      },
      () => setFounder(null),
    )
  }, [uid])
  const founderInfo = founder?.uid === uid ? founder.info : null

  // Founders see the warning first: for the account, and for the Spark profile.
  function ask(what: 'profile' | 'account') {
    setHidden(false)
    if (founderInfo && (what === 'account' || mode === 'spark')) setWarning(what)
    else setPending(what)
  }

  async function hideInstead() {
    setBusy(true)
    setError(null)
    try {
      // Both modes; a mode without a profile just stores the setting.
      await Promise.all([setVisibility('spark', 'hidden'), setVisibility('play', 'hidden')])
      setWarning(null)
      setHidden(true)
    } catch {
      setError("Couldn't hide your account. Try again.")
    } finally {
      setBusy(false)
    }
  }

  async function leaveSignedOut() {
    await signOutAndWipe({ keepChatKey: false })
    // signOutAndWipe loads /login itself (a fresh page).
  }

  async function confirmProfile() {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'spark') {
        const { playRemains } = await deleteSparkProfile(uid)
        if (!playRemains) return void (await leaveSignedOut())
        // Into Play the normal way — access check, PIN, transition (Header
        // runs it from the param); the PIN is always required for Play.
        return void navigate('/discover?enter_play=true', { replace: true })
      } else {
        const { sparkRemains } = await deletePlayProfile(uid)
        if (!sparkRemains) return void (await leaveSignedOut())
        setMode('spark')
      }
      navigate('/discover', { replace: true })
    } catch {
      setError("Couldn't delete your profile. Try again.")
      setBusy(false)
    }
  }

  async function confirmAccount() {
    setBusy(true)
    setError(null)
    try {
      await deleteAccount()
      await leaveSignedOut()
    } catch {
      setError("Couldn't delete your account. Try again.")
      setBusy(false)
    }
  }

  const row = 'flex w-full items-center justify-between border-t border-white/5 px-5 py-4 text-left hover:bg-white/[0.03]'
  return (
    <>
      <button type="button" onClick={() => ask('profile')} className={row}>
        <span>
          <span className="block font-medium text-red-400">{copy.row}</span>
          <span className="block text-sm text-white/50">{copy.rowSub}</span>
        </span>
        <span className="text-white/30" aria-hidden>
          ›
        </span>
      </button>
      <button type="button" onClick={() => ask('account')} className={row}>
        <span>
          <span className="block font-medium text-red-400">Delete account</span>
          <span className="block text-sm text-white/50">Delete both profiles and your account.</span>
        </span>
        <span className="text-white/30" aria-hidden>
          ›
        </span>
      </button>

      {hidden && <p className="px-5 pb-4 pt-1 text-sm text-emerald-300">Your account is hidden. Your founder status is safe.</p>}

      {warning && founderInfo && (
        <FounderWarningModal
          founder={founderInfo}
          what={warning}
          busy={busy}
          error={error}
          onHide={() => void hideInstead()}
          onDelete={() => {
            setPending(warning)
            setWarning(null)
            setError(null)
          }}
          onCancel={() => {
            setWarning(null)
            setError(null)
          }}
        />
      )}

      {pending === 'profile' && (
        <ConfirmModal
          title={copy.title}
          body={copy.body}
          confirm={copy.confirm}
          busy={busy}
          error={error}
          onConfirm={() => void confirmProfile()}
          onCancel={() => {
            setPending(null)
            setError(null)
          }}
        />
      )}
      {pending === 'account' && (
        <ConfirmModal
          title="Delete your account?"
          body={ACCOUNT_DELETE_BODY}
          confirm="Delete my account"
          typeToConfirm="DELETE"
          busy={busy}
          error={error}
          onConfirm={() => void confirmAccount()}
          onCancel={() => {
            setPending(null)
            setError(null)
          }}
        />
      )}
    </>
  )
}
