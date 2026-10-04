import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import {
  backUpKeyWithPin,
  checkKeyState,
  keysReady,
  resetKeyOnThisDevice,
  restoreKeyWithPin,
  subscribeKeyState,
  type KeyState,
} from '../services/keys'
import { PIN_LENGTH, pinProblem } from '../services/keyBackup'
import { friendlyError } from '../services/errors'

// Chat key backup, WhatsApp-style (services/keyBackup.ts):
// - this browser has the key but no backup → "Protect your chats" (set a PIN)
// - it doesn't have the key and a backup exists → "Unlock your chats" (PIN)
// - it doesn't have the key and there's no backup → set a PIN on the device
//   that has it, or start fresh here
// Anything can open it: window.dispatchEvent(new CustomEvent(KEY_BACKUP_EVENT,
// { detail: 'set' | 'unlock' })) — Settings and the chat banner do.

export const KEY_BACKUP_EVENT = 'zylove:key-backup'
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000
const snoozeKey = (uid: string) => `zylove_keybackup_snooze_${uid}`

function snoozed(uid: string): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(snoozeKey(uid)) ?? 0) < SNOOZE_MS
  } catch {
    return false
  }
}

function snooze(uid: string): void {
  try {
    localStorage.setItem(snoozeKey(uid), String(Date.now()))
  } catch {
    // Storage unavailable: it asks again next visit.
  }
}

type View = null | 'set' | 'unlock' | 'locked' | 'reset' | 'done' | 'retry'

export default function KeyBackupGate() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [state, setState] = useState<KeyState | null>(null)
  const [view, setView] = useState<View>(null)
  // Dismissed for this session (the chat banner can still reopen it).
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!uid) return
    const unsub = subscribeKeyState(uid, setState)
    // Fresh check on entry: covers accounts created by onboarding after sign-in.
    keysReady(uid)
      .then(() => checkKeyState(uid))
      .catch(() => {})
    return unsub
  }, [uid])

  // Open on its own once per session when something needs doing.
  useEffect(() => {
    if (!uid || !state || view !== null || dismissed) return
    if (state.status === 'needs_restore') setView('unlock')
    else if (state.status === 'locked') setView('locked')
    else if (state.status === 'check_failed') setView('retry')
    else if (state.status === 'ready' && state.backedUp === false && !snoozed(uid)) {
      const t = setTimeout(() => setView('set'), 2500)
      return () => clearTimeout(t)
    }
  }, [uid, state, view, dismissed])

  useEffect(() => {
    function open(e: Event) {
      const want = (e as CustomEvent<'set' | 'unlock'>).detail
      const status = state?.status
      if (status === 'check_failed') {
        setView('retry')
      } else if (want === 'unlock' || status === 'needs_restore' || status === 'locked') {
        setView(status === 'locked' ? 'locked' : 'unlock')
      } else {
        setView('set')
      }
    }
    window.addEventListener(KEY_BACKUP_EVENT, open)
    return () => window.removeEventListener(KEY_BACKUP_EVENT, open)
  }, [state])

  if (!uid || view === null) return null

  const close = () => {
    if (view === 'set' && state?.backedUp === false) snooze(uid)
    setDismissed(true)
    setView(null)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="key-backup-title"
      className="fixed inset-0 z-[85] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
    >
      <div className="w-full rounded-t-2xl border border-white/10 bg-gray-950 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
        {view === 'set' && (
          <SetPin
            replacing={state?.backedUp === true}
            onSave={async (pin) => {
              await backUpKeyWithPin(uid, pin)
              setView('done')
            }}
            onCancel={close}
          />
        )}
        {view === 'unlock' && <Unlock uid={uid} onUnlocked={() => setView(null)} onForgot={() => setView('reset')} onCancel={close} />}
        {view === 'locked' && <Locked onReset={() => setView('reset')} onCancel={close} />}
        {view === 'retry' && (
          <Retry
            onRetry={async () => {
              const next = await checkKeyState(uid)
              setView(next.status === 'check_failed' ? 'retry' : null)
            }}
            onCancel={close}
          />
        )}
        {view === 'reset' && (
          <ResetConfirm
            onConfirm={async () => {
              await resetKeyOnThisDevice(uid)
              setView('set')
            }}
            onCancel={() => setView(state?.status === 'locked' ? 'locked' : 'unlock')}
          />
        )}
        {view === 'done' && (
          <>
            <h2 id="key-backup-title" className="text-xl font-bold">
              ✦ Your chats are protected
            </h2>
            <p className="mt-2 text-sm text-white/60">
              On a new device, sign in and enter your chat PIN to read your messages. Keep it somewhere safe — we can't recover it
              for you.
            </p>
            <button type="button" onClick={() => setView(null)} className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold">
              Done
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function PinInput({ value, onChange, label, autoFocus }: { value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean }) {
  return (
    <label className="mt-5 block">
      <span className="sr-only">{label}</span>
      <input
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        maxLength={PIN_LENGTH}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
        placeholder={'•'.repeat(PIN_LENGTH)}
        aria-label={label}
        className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-center text-2xl tracking-[0.5em] text-white placeholder:text-white/20 focus:border-[#1B4FD8] focus:outline-none"
      />
    </label>
  )
}

function SetPin({ replacing, onSave, onCancel }: { replacing: boolean; onSave: (pin: string) => Promise<void>; onCancel: () => void }) {
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function next() {
    setError(null)
    if (confirm === null) {
      const problem = pinProblem(pin)
      if (problem) return setError(problem)
      return setConfirm('')
    }
    if (confirm !== pin) {
      setConfirm('')
      return setError("Those PINs don't match. Enter it again.")
    }
    setBusy(true)
    try {
      await onSave(pin)
    } catch (err) {
      console.error('Chat key backup failed', err)
      setError(friendlyError(err, "Couldn't save your chat PIN. Try again."))
      setBusy(false)
    }
  }

  const value = confirm === null ? pin : confirm
  return (
    <>
      <h2 id="key-backup-title" className="text-xl font-bold">
        {confirm === null ? (replacing ? 'Change your chat PIN' : 'Protect your chats') : 'Confirm your PIN'}
      </h2>
      <p className="mt-2 text-sm text-white/60">
        {confirm === null
          ? "Set a 4-digit PIN so you can read your messages on any device. You'll enter it when you sign in somewhere new."
          : 'Enter the same 4 digits again.'}
      </p>
      <PinInput
        key={confirm === null ? 'pin' : 'confirm'}
        value={value}
        onChange={(v) => (confirm === null ? setPin(v) : setConfirm(v))}
        label={confirm === null ? 'New chat PIN' : 'Confirm chat PIN'}
        autoFocus
      />
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <button
        type="button"
        onClick={() => void next()}
        disabled={busy || value.length !== PIN_LENGTH}
        className="mt-5 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold disabled:opacity-40"
      >
        {busy ? 'Encrypting…' : confirm === null ? 'Next' : 'Save PIN'}
      </button>
      <p className="mt-3 text-xs text-white/40">We never see your PIN, and we can't recover it if you forget it.</p>
      <button type="button" onClick={onCancel} disabled={busy} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
        Not now
      </button>
    </>
  )
}

function Unlock({ uid, onUnlocked, onForgot, onCancel }: { uid: string; onUnlocked: () => void; onForgot: () => void; onCancel: () => void }) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function unlock() {
    setBusy(true)
    setError(null)
    try {
      const r = await restoreKeyWithPin(uid, pin)
      if (r.ok) return onUnlocked()
      setPin('')
      if (r.reason === 'wrong_pin') setError(`That PIN isn't right. ${r.attemptsLeft} ${r.attemptsLeft === 1 ? 'try' : 'tries'} left.`)
      else if (r.reason === 'locked')
        setError(`Too many tries. Try again after ${new Date(r.lockedUntil).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`)
      else if (r.reason === 'corrupt') setError('That backup is for an older chat key. Tap "Forgot PIN?" to start fresh.')
      else setError('No chat backup found. Tap "Forgot PIN?" to start fresh.')
    } catch (err) {
      console.error('Chat key restore failed', err)
      setError(friendlyError(err, "Couldn't unlock your chats. Try again."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2 id="key-backup-title" className="text-xl font-bold">
        Unlock your chats
      </h2>
      <p className="mt-2 text-sm text-white/60">Enter the 4-digit chat PIN you set on another device to read your messages here.</p>
      <PinInput value={pin} onChange={setPin} label="Chat PIN" autoFocus />
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <button
        type="button"
        onClick={() => void unlock()}
        disabled={busy || pin.length !== PIN_LENGTH}
        className="mt-5 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold disabled:opacity-40"
      >
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      <div className="mt-3 flex justify-between text-sm">
        <button type="button" onClick={onForgot} disabled={busy} className="text-white/50 underline hover:text-white">
          Forgot PIN?
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="text-white/50 hover:text-white">
          Not now
        </button>
      </div>
    </>
  )
}

function Locked({ onReset, onCancel }: { onReset: () => void; onCancel: () => void }) {
  return (
    <>
      <h2 id="key-backup-title" className="text-xl font-bold">
        Your chats are on another device
      </h2>
      <p className="mt-2 text-sm text-white/60">
        Your messages are locked to the browser where you've been using Zylove. Open Zylove there, go to Settings → Chat PIN and
        set one, then come back here and unlock.
      </p>
      <button type="button" onClick={onCancel} className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold">
        Got it
      </button>
      <button type="button" onClick={onReset} className="mt-2 w-full py-2 text-sm text-white/50 underline hover:text-white">
        Start fresh on this device instead
      </button>
    </>
  )
}

function ResetConfirm({ onConfirm, onCancel }: { onConfirm: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <h2 id="key-backup-title" className="text-xl font-bold">
        Start fresh on this device?
      </h2>
      <p className="mt-2 text-sm text-white/60">
        You'll get a new chat key and set a new PIN. Messages sent before now won't be readable here, and your other devices will
        need the new PIN to read new messages.
      </p>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(null)
          onConfirm().catch((err: unknown) => {
            console.error('Chat key reset failed', err)
            setError(friendlyError(err, "Couldn't start fresh. Try again."))
            setBusy(false)
          })
        }}
        className="mt-6 w-full rounded-xl bg-red-600 py-3 font-semibold hover:bg-red-500 disabled:opacity-50"
      >
        {busy ? 'Setting up…' : 'Start fresh'}
      </button>
      <button type="button" onClick={onCancel} disabled={busy} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
        Go back
      </button>
    </>
  )
}

// The backup lookup failed (offline, server hiccup): never guess "no backup"
// here — that's how a good backup gets overwritten.
function Retry({ onRetry, onCancel }: { onRetry: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <>
      <h2 id="key-backup-title" className="text-xl font-bold">
        Couldn't check your chat backup
      </h2>
      <p className="mt-2 text-sm text-white/60">
        We need to check for your chat PIN backup before your messages can open on this device. Check your connection and try
        again.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          onRetry().finally(() => setBusy(false))
        }}
        className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold disabled:opacity-50"
      >
        {busy ? 'Checking…' : 'Try again'}
      </button>
      <button type="button" onClick={onCancel} disabled={busy} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
        Not now
      </button>
    </>
  )
}
