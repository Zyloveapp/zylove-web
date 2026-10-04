import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { MODE_ACCENT, useBackLinkClass, useModeStore } from '../store/modeStore'
import { hasPin } from '../services/playPin'
import {
  SMS_SECTIONS,
  grantSmsConsent,
  sectionPreferences,
  setSmsEnabled,
  setQuietHours,
  setQuietNudge,
  setSmsPreference,
  subscribeSmsSettings,
  type QuietHours,
  type SmsSettings,
} from '../services/notifications'
import PlayPinFlow from '../components/PlayPinFlow'
import SmsConsentModal from '../components/SmsConsentModal'
import DiscoverySettings from '../components/DiscoverySettings'
import InstallAppSection from '../components/InstallAppSection'
import BlockedUsersLink from '../components/BlockedUsersLink'
import DeleteProfileControls from '../components/DeleteProfileControls'
import MembershipSection from '../components/MembershipSection'
import FounderSettingsSection from '../components/FounderSettingsSection'
import { getFounderThreads } from '../services/founderMessages'
import PhotoConsentCopy from '../components/PhotoConsentCopy'
import { isAdmin } from '../services/adminPhotos'
import { listDeletions } from '../services/adminTools'
import { setPhotoConsent, subscribePhotoConsent, type PhotoConsent, type PhotoConsentMode } from '../services/photoConsent'

// On colour: cobalt by default (settings that cover both modes), red for Play.
const SWITCH_ON = { spark: 'bg-[#1B4FD8]', play: 'bg-[#E03131]' } as const

function Switch({
  checked,
  disabled,
  label,
  onChange,
  tone = 'spark',
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
  tone?: keyof typeof SWITCH_ON
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
        checked ? SWITCH_ON[tone] : 'bg-white/15'
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

const PHOTO_COACHING: { mode: PhotoConsentMode; label: string; description: string }[] = [
  { mode: 'spark', label: 'Analyze my Spark photos', description: 'Allows AI coaching to review your Spark profile photos.' },
  { mode: 'play', label: 'Analyze my Play photos', description: 'Allows AI coaching to review your Play profile photos.' },
]

function PhotoConsentModal({
  mode,
  onAccept,
  onCancel,
  busy,
}: {
  mode: PhotoConsentMode
  onAccept: () => void
  onCancel: () => void
  busy: boolean
}) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="photo-consent-title"
    >
      <div className="w-full rounded-t-2xl bg-gray-900 px-6 pt-6 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-sm lg:rounded-2xl lg:pb-6">
        <h2 id="photo-consent-title" className="text-xl font-bold">
          Photo analysis consent
        </h2>
        <PhotoConsentCopy mode={mode} className="mt-3 text-sm leading-relaxed text-white/70" />
        <button
          type="button"
          onClick={onAccept}
          disabled={busy}
          autoFocus
          className={`mt-6 w-full rounded-xl ${SWITCH_ON[mode]} py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50`}
        >
          I understand, enable
        </button>
        <button type="button" onClick={onCancel} className="mt-2 w-full py-2 text-sm text-white/50 hover:text-white">
          Cancel
        </button>
      </div>
    </div>
  )
}

// Privacy → per-mode opt-in for AI photo coaching in the profile reviews.
// Turning one on asks for consent the first time; off is immediate.
function PrivacySection({ uid }: { uid: string }) {
  // Only the current mode's photo consent.
  const currentMode = useModeStore((st) => st.mode)
  const [loaded, setLoaded] = useState<{ uid: string; consent: PhotoConsent } | null>(null)
  const [pending, setPending] = useState<PhotoConsentMode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!uid) return
    return subscribePhotoConsent(
      uid,
      (consent) => setLoaded({ uid, consent }),
      () => setError("Couldn't load your privacy settings."),
    )
  }, [uid])

  const consent = loaded?.uid === uid ? loaded.consent : null

  async function save(mode: PhotoConsentMode, enabled: boolean, acknowledge = false) {
    setBusy(true)
    setError(null)
    try {
      await setPhotoConsent(uid, mode, enabled, { acknowledge })
    } catch {
      setError("Couldn't save that. Try again.")
    } finally {
      setBusy(false)
    }
  }

  function toggle(mode: PhotoConsentMode, next: boolean) {
    if (next && !consent?.acknowledged) return setPending(mode)
    void save(mode, next)
  }

  async function accept() {
    if (!pending) return
    await save(pending, true, true)
    setPending(null)
  }

  return (
    <Section title="Privacy">
      <p className="px-5 pt-3 font-medium">Profile photo coaching</p>
      <ul className="pb-1">
        {PHOTO_COACHING.filter((p) => p.mode === currentMode).map(({ mode, label, description }) => (
          <li key={mode} className="flex items-center justify-between gap-4 px-5 py-3">
            <span>
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-white/40">{description}</span>
            </span>
            <Switch
              checked={consent?.[mode] ?? false}
              disabled={consent === null || busy}
              label={label}
              tone={mode}
              onChange={(next) => toggle(mode, next)}
            />
          </li>
        ))}
      </ul>
      {error && <p className="px-5 pb-2 text-sm text-red-400">{error}</p>}
      <p className="border-t border-white/5 px-5 py-3 text-xs text-white/40">
        Zylove uses a third-party AI service to analyze photos for profile coaching. Photos are analyzed for coaching
        feedback and not used for any other purpose.
      </p>
      {pending && <PhotoConsentModal mode={pending} busy={busy} onAccept={() => void accept()} onCancel={() => setPending(null)} />}
    </Section>
  )
}

// Only rendered for users/{uid}.isAdmin === true.
function AdminSection({ uid }: { uid: string }) {
  const navigate = useNavigate()
  const [admin, setAdmin] = useState<{ uid: string; value: boolean } | null>(null)
  // Founder threads with something the admin hasn't opened.
  const [unread, setUnread] = useState(0)
  const [pendingDeletions, setPendingDeletions] = useState(0)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    isAdmin(uid)
      .catch(() => false)
      .then((value) => {
        if (cancelled) return
        setAdmin({ uid, value })
        if (value) {
          getFounderThreads()
            .then(({ threads }) => !cancelled && setUnread(threads.filter((t) => t.hasUnread).length))
            .catch(() => {})
          listDeletions()
            .then((d) => !cancelled && setPendingDeletions(d.length))
            .catch(() => {})
        }
      })
    return () => {
      cancelled = true
    }
  }, [uid])

  if (admin?.uid !== uid || !admin.value) return null
  return (
    <Section title="Admin">
      <button
        type="button"
        onClick={() => navigate('/admin/messages')}
        className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-white/[0.03]"
      >
        <span className="flex items-center gap-2 font-medium">
          Founder messages
          {unread > 0 && (
            <span className="rounded-full bg-[#E03131] px-2 py-0.5 text-xs font-semibold text-white">{unread}</span>
          )}
        </span>
        <span className="text-white/30" aria-hidden>
          →
        </span>
      </button>
      <button
        type="button"
        onClick={() => navigate('/admin/photos')}
        className="flex w-full items-center justify-between border-t border-white/5 px-5 py-4 text-left hover:bg-white/[0.03]"
      >
        <span>
          <span className="block font-medium">Photo review</span>
          <span className="block text-sm text-white/50">Approve or reject photos moderation held back.</span>
        </span>
        <span className="text-white/30" aria-hidden>
          ›
        </span>
      </button>
      <button
        type="button"
        onClick={() => navigate('/admin/deletions')}
        className="flex w-full items-center justify-between border-t border-white/5 px-5 py-4 text-left hover:bg-white/[0.03]"
      >
        <span className="flex items-center gap-2 font-medium">
          🗑 Deletion queue
          {pendingDeletions > 0 && (
            <span className="rounded-full bg-[#E03131] px-2 py-0.5 text-xs font-semibold text-white">{pendingDeletions}</span>
          )}
        </span>
        <span className="text-white/30" aria-hidden>
          →
        </span>
      </button>
      <button
        type="button"
        onClick={() => navigate('/admin/cities')}
        className="flex w-full items-center justify-between border-t border-white/5 px-5 py-4 text-left hover:bg-white/[0.03]"
      >
        <span className="font-medium">🏙 City dashboard</span>
        <span className="text-white/30" aria-hidden>
          →
        </span>
      </button>
      <button
        type="button"
        onClick={() => navigate('/admin/activity')}
        className="flex w-full items-center justify-between border-t border-white/5 px-5 py-4 text-left hover:bg-white/[0.03]"
      >
        <span className="font-medium">📊 Activity dashboard</span>
        <span className="text-white/30" aria-hidden>
          →
        </span>
      </button>
    </Section>
  )
}

type Loaded = { uid: string; settings: SmsSettings } | 'error'

export default function Settings() {
  const backLinkClass = useBackLinkClass()
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const phone = useAuthStore((s) => s.user?.phoneNumber) ?? null
  // Only the current mode's notification section is shown.
  const mode = useModeStore((s) => s.mode)
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
  // Each mode has its own master switch; this page shows the current mode's.
  const enabled = sms?.enabled?.[mode] === true

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
    const current = sms?.enabled ?? null
    if (!next) return void run(() => setSmsEnabled(uid, mode, false, current))
    // Consent is asked once per account (from either mode); after that,
    // switching a mode on is immediate.
    if (sms?.consented) return void run(() => setSmsEnabled(uid, mode, true, current))
    setConsentOpen(true)
  }

  async function acceptConsent() {
    if (!phone) return
    await run(() => grantSmsConsent(uid, phone, mode))
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
    <div
      className="min-h-[calc(100dvh-7rem)] bg-gray-950 px-4 py-6 text-white"
      style={{ '--zy-accent': MODE_ACCENT[mode].cssVar } as CSSProperties}
    >
      <div className="mx-auto max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className={`text-sm font-medium ${backLinkClass} hover:text-white`}
          >
            ← Back
          </button>
          <h1 className="text-2xl font-bold">Settings</h1>
        </div>

        <MembershipSection uid={uid} />

        <FounderSettingsSection uid={uid} />

        <InstallAppSection />

        <DiscoverySettings />

        <Section title="Notifications">
          {SMS_SECTIONS.filter((section) => section.mode === mode).map(({ mode, title, items }) => {
            const prefs = sms ? sectionPreferences(sms.preferences, mode) : null
            return (
              <div key={mode}>
                {/* This mode's master switch: its texts only go out while it's on. */}
                <div className="flex items-center justify-between gap-4 px-5 py-4">
                  <span>
                    <span className={`block font-medium ${mode === 'play' ? 'text-red-300' : 'text-[#9DB4FF]'}`}>{title}</span>
                    <span className="block text-sm text-white/40">
                      {phone ? `Texts to ${phone}` : 'Sign in with a phone number to get texts.'}
                    </span>
                  </span>
                  <Switch
                    checked={enabled}
                    disabled={busy || sms === null || !phone}
                    label={title}
                    tone={mode}
                    onChange={toggleMaster}
                  />
                </div>
                <ul className={`border-t border-white/5 py-2 transition-opacity ${enabled ? '' : 'opacity-40'}`}>
                  {items.map(({ key, label, description }) => (
                    <li key={key} className="flex items-center justify-between gap-4 px-5 py-2.5">
                      <span>
                        <span className="block text-sm font-medium">{label}</span>
                        <span className="block text-xs text-white/40">{description}</span>
                      </span>
                      <Switch
                        checked={prefs?.[key] ?? false}
                        disabled={!enabled || busy}
                        label={`${title}: ${label}`}
                        tone={mode}
                        onChange={(next) => void run(() => setSmsPreference(uid, mode, key, next))}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}

          <div
            className={`flex items-center justify-between gap-4 border-t border-white/5 px-5 py-4 transition-opacity ${
              enabled ? '' : 'opacity-40'
            }`}
          >
            <span>
              <span className="block text-sm font-medium">Quiet chat nudge</span>
              <span className="block text-xs text-white/40">A conversation has gone quiet (Spark and Play)</span>
            </span>
            <Switch
              checked={sms?.preferences.quietNudge ?? false}
              disabled={!enabled || busy}
              label="Quiet chat nudge"
              tone={mode}
              onChange={(next) => void run(() => setQuietNudge(uid, next))}
            />
          </div>

          <div className={`border-t border-white/5 px-5 py-4 transition-opacity ${enabled ? '' : 'opacity-40'}`}>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">Quiet hours</h3>
            <div className="mt-3 flex items-center justify-between gap-4">
              <span className="text-sm font-medium">Pause notifications overnight</span>
              <Switch
                checked={sms?.quietHours.enabled ?? true}
                disabled={!enabled || busy}
                label="Pause notifications overnight"
              tone={mode}
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

        <PrivacySection uid={uid} />

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

        <AdminSection uid={uid} />

        {/* The current mode's reviews only (the history page reads the mode). */}
        <Section title="Profile reviews">
          <button
            type="button"
            onClick={() => navigate('/settings/reviews')}
            className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-white/[0.03]"
          >
            <span className="block font-medium">My review history</span>
            <span className="text-white/30" aria-hidden>
              →
            </span>
          </button>
        </Section>

        <Section title="Account">
          <p className="px-5 pt-2 text-sm text-white/40">
            ✦ Zylove has two modes — Spark and Play. Tap the mode pill in the header to explore.
          </p>
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
          <DeleteProfileControls uid={uid} />
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
        <SmsConsentModal busy={busy} onAccept={acceptConsent} onDecline={() => setConsentOpen(false)} />
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
