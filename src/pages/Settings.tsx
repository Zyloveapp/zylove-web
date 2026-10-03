import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { hasPin } from '../services/playPin'
import {
  SMS_PREFERENCES,
  grantSmsConsent,
  setSmsEnabled,
  setQuietHours,
  setSmsPreference,
  subscribeSmsSettings,
  type QuietHours,
  type SmsPreference,
  type SmsSettings,
} from '../services/notifications'
import PlayPinFlow from '../components/PlayPinFlow'
import DiscoverySettings from '../components/DiscoverySettings'
import BlockedUsersLink from '../components/BlockedUsersLink'

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed ${
        checked ? 'bg-[#1B4FD8]' : 'bg-white/15'
      }`}
    >
      <span
        className={`absolute top-1 left-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : ''
        }`}
      />
    </button>
  )
}

// 'HH:MM' every 30 minutes, labelled like "9:00 PM".
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2)
  const m = i % 2 === 0 ? '00' : '30'
  return { value: `${String(h).padStart(2, '0')}:${m}`, label: timeLabel(h, m) }
})

function timeLabel(h: number, m: string): string {
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`
}

function TimeSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: string
  disabled: boolean
  onChange: (v: string) => void
}) {
  // A saved time off the 30-minute grid (set elsewhere) still shows.
  const options = TIME_OPTIONS.some((o) => o.value === value)
    ? TIME_OPTIONS
    : [{ value, label: timeLabel(Number(value.slice(0, 2)), value.slice(3)) }, ...TIME_OPTIONS]
  return (
    <label className="flex-1">
      <span className="mb-1 block text-xs text-white/40">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-white/10 bg-gray-900 px-3 py-2.5 text-white focus:border-white/30 focus:outline-none disabled:cursor-not-allowed"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/5">
      <h2 className="px-5 pt-4 text-xs font-semibold uppercase tracking-widest text-white/40">{title}</h2>
      {children}
    </section>
  )
}

function ConsentModal({ onAccept, onDecline, busy }: { onAccept: () => void; onDecline: () => void; busy: boolean }) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onDecline()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDecline])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sms-consent-title"
    >
      <div className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
        <h2 id="sms-consent-title" className="text-xl font-bold">
          Get Zylove updates by text
        </h2>
        <p className="mt-2 text-sm text-white/60">
          We'll text you when something important happens — a new Spark, a message, a match. Standard rates apply. You can
          turn this off anytime.
        </p>
        {/* Carrier (A2P) consent wording: frequency + how to opt out. */}
        <p className="mt-2 text-xs text-white/40">Message frequency varies. Reply STOP to opt out, HELP for help.</p>
        <button
          type="button"
          onClick={onAccept}
          disabled={busy}
          autoFocus
          className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Turning on…' : 'Turn on'}
        </button>
        <button
          type="button"
          onClick={onDecline}
          disabled={busy}
          className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white"
        >
          Not now
        </button>
      </div>
    </div>
  )
}

type Loaded = { uid: string; settings: SmsSettings } | 'error'

export default function Settings() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const phone = useAuthStore((s) => s.user?.phoneNumber) ?? null
  const navigate = useNavigate()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [consentOpen, setConsentOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pinFlow, setPinFlow] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Re-read on every render: the flow can set or clear the PIN.
  const pinSet = uid ? hasPin(uid) : false

  useEffect(() => {
    if (!uid) return
    return subscribeSmsSettings(
      uid,
      (settings) => setLoaded({ uid, settings }),
      () => setLoaded('error'),
    )
  }, [uid])

  const sms = loaded !== null && loaded !== 'error' && loaded.uid === uid ? loaded.settings : null
  const enabled = sms?.enabled === true

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch {
      setError("Couldn't save that. Try again.")
    } finally {
      setBusy(false)
    }
  }

  function toggleMaster(next: boolean) {
    if (!next) return void run(() => setSmsEnabled(uid, false))
    // Consent is asked once; after that, switching back on is immediate.
    if (sms?.consented) return void run(() => setSmsEnabled(uid, true))
    setConsentOpen(true)
  }

  async function acceptConsent() {
    if (!phone) return
    await run(() => grantSmsConsent(uid, phone))
    setConsentOpen(false)
  }

  function saveQuietHours(patch: Partial<Omit<QuietHours, 'timezone'>>) {
    if (!sms) return
    const { enabled: on, from, until } = sms.quietHours
    void run(() => setQuietHours(uid, { enabled: on, from, until, ...patch }))
  }

  async function handleSignOut() {
    await signOut(auth)
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-[calc(100dvh-7rem)] bg-gray-950 px-4 py-6 text-white">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="text-sm font-medium text-[#7C9BFF] hover:text-white"
          >
            ← Back
          </button>
          <h1 className="text-2xl font-bold">Settings</h1>
        </div>

        <DiscoverySettings />

        <Section title="Notifications">
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <span>
              <span className="block font-medium">SMS Notifications</span>
              <span className="block text-sm text-white/40">
                {phone ? `Texts to ${phone}` : 'Sign in with a phone number to get texts.'}
              </span>
            </span>
            <Switch
              checked={enabled}
              disabled={busy || sms === null || !phone}
              label="SMS Notifications"
              onChange={toggleMaster}
            />
          </div>

          <ul className={`border-t border-white/5 transition-opacity ${enabled ? '' : 'opacity-40'}`}>
            {SMS_PREFERENCES.map(({ key, label, description }) => (
              <li key={key} className="flex items-center justify-between gap-4 px-5 py-3">
                <span>
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-white/40">{description}</span>
                </span>
                <Switch
                  checked={sms?.preferences[key as SmsPreference] ?? false}
                  disabled={!enabled || busy}
                  label={label}
                  onChange={(next) => void run(() => setSmsPreference(uid, key, next))}
                />
              </li>
            ))}
          </ul>

          <div className={`border-t border-white/5 px-5 py-4 transition-opacity ${enabled ? '' : 'opacity-40'}`}>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">Quiet hours</h3>
            <div className="mt-3 flex items-center justify-between gap-4">
              <span className="text-sm font-medium">Pause notifications overnight</span>
              <Switch
                checked={sms?.quietHours.enabled ?? true}
                disabled={!enabled || busy}
                label="Pause notifications overnight"
                onChange={(next) => saveQuietHours({ enabled: next })}
              />
            </div>
            {sms?.quietHours.enabled && (
              <div className="mt-3 flex gap-3">
                <TimeSelect
                  label="From"
                  value={sms.quietHours.from}
                  disabled={!enabled || busy}
                  onChange={(from) => saveQuietHours({ from })}
                />
                <TimeSelect
                  label="Until"
                  value={sms.quietHours.until}
                  disabled={!enabled || busy}
                  onChange={(until) => saveQuietHours({ until })}
                />
              </div>
            )}
            <p className="mt-2 text-xs text-white/40">All times are in your local timezone.</p>
          </div>

          {error && <p className="px-5 pb-2 text-sm text-red-400">{error}</p>}
          {loaded === 'error' && <p className="px-5 pb-2 text-sm text-red-400">Couldn't load your notification settings.</p>}
          <p className="border-t border-white/5 px-5 py-3 text-xs text-white/40">
            Standard message rates apply. You can turn off SMS notifications anytime.
          </p>
        </Section>

        <Section title="Safety">
          <button
            type="button"
            onClick={() => navigate('/settings/report')}
            className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-white/[0.03]"
          >
            <span>
              <span className="block font-medium">Report a past connection</span>
              <span className="block text-sm text-white/50">Anyone you matched with in the last 90 days.</span>
            </span>
            <span className="text-white/30" aria-hidden>
              ›
            </span>
          </button>
          <BlockedUsersLink />
        </Section>

        <Section title="Account">
          <button
            type="button"
            onClick={() => {
              setNotice(null)
              setPinFlow(true)
            }}
            className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-white/[0.03]"
          >
            <span>
              <span className="block font-medium">{pinSet ? 'Change Play PIN' : 'Set a Play PIN'}</span>
              <span className="block text-sm text-white/50">Keeps Play mode private on shared devices.</span>
            </span>
            <span className="text-white/30" aria-hidden>
              ›
            </span>
          </button>
          {notice && <p className="px-5 pb-4 text-sm text-emerald-300">{notice}</p>}
          <button
            type="button"
            onClick={handleSignOut}
            className="w-full border-t border-white/5 px-5 py-4 text-left font-medium text-red-400 hover:bg-white/[0.03]"
          >
            Sign out
          </button>
        </Section>
      </div>

      {consentOpen && (
        <ConsentModal busy={busy} onAccept={acceptConsent} onDecline={() => setConsentOpen(false)} />
      )}

      {pinFlow && (
        <PlayPinFlow
          uid={uid}
          purpose="change"
          onDone={() => {
            setPinFlow(false)
            setNotice('Play PIN updated ✦')
          }}
          onCancel={() => setPinFlow(false)}
        />
      )}
    </div>
  )
}
