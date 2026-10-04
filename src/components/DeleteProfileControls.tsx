import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../services/firebase'
import { useModeStore } from '../store/modeStore'
import { deleteAccount, deletePlayProfile, deleteSparkProfile } from '../services/profileDeletion'

type Pending = 'profile' | 'account' | null

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

function ConfirmModal({
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
        <p className="mt-2 text-sm text-white/60">{body}</p>
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
  const copy = COPY[mode]

  async function leaveSignedOut() {
    await signOut(auth).catch(() => {})
    navigate('/login', { replace: true })
  }

  async function confirmProfile() {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'spark') {
        const { playRemains } = await deleteSparkProfile(uid)
        if (!playRemains) return void (await leaveSignedOut())
        setMode('play')
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
      <button type="button" onClick={() => setPending('profile')} className={row}>
        <span>
          <span className="block font-medium text-red-400">{copy.row}</span>
          <span className="block text-sm text-white/50">{copy.rowSub}</span>
        </span>
        <span className="text-white/30" aria-hidden>
          ›
        </span>
      </button>
      <button type="button" onClick={() => setPending('account')} className={row}>
        <span>
          <span className="block font-medium text-red-400">Delete account</span>
          <span className="block text-sm text-white/50">Permanently delete everything — both profiles and your account.</span>
        </span>
        <span className="text-white/30" aria-hidden>
          ›
        </span>
      </button>

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
          body="This permanently deletes your Spark profile, Play profile, all matches and messages. This cannot be undone."
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
