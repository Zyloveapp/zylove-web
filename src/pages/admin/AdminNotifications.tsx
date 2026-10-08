import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import {
  ADMIN_ALERT_GROUPS,
  ADMIN_CONSENT_TEXT,
  getAdminSmsStatus,
  saveAdminNotificationSettings,
  subscribeAdminNotificationSettings,
  type AdminNotificationSettings,
  type AdminSmsStatus,
  type SettingsPatch,
} from '../../services/adminNotifications'

// /admin/notifications: which admin events text you, quiet hours and the
// test accounts never alerted about. Separate from your own user
// notifications (Settings → Notifications), which this never changes.
// Push is a later task: only the SMS column is shown.

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? 'bg-[#1B4FD8]' : 'bg-white/15'
      }`}
    >
      <span className={`absolute top-1 left-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
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

const TIMES = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2)
  const m = i % 2 === 0 ? '00' : '30'
  return { value: `${String(h).padStart(2, '0')}:${m}`, label: `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}` }
})

function TimeSelect({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const options = TIMES.some((o) => o.value === value) ? TIMES : [{ value, label: value }, ...TIMES]
  return (
    <label className="flex-1">
      <span className="mb-1 block text-xs text-white/40">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-white/10 bg-gray-900 px-3 py-2.5 text-white focus:border-white/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
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

const row = 'flex items-center justify-between gap-4 border-t border-white/5 px-5 py-3.5'

export default function AdminNotifications() {
  const navigate = useNavigate()
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [settings, setSettings] = useState<AdminNotificationSettings | null>(null)
  const [status, setStatus] = useState<AdminSmsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [consentTicked, setConsentTicked] = useState(false)
  const [newUid, setNewUid] = useState('')

  useEffect(() => {
    if (!uid) return
    return subscribeAdminNotificationSettings(uid, setSettings, () => setError("Couldn't load your admin notification settings."))
  }, [uid])

  useEffect(() => {
    getAdminSmsStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  async function save(patch: SettingsPatch, message?: string) {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const { confirmation } = await saveAdminNotificationSettings(patch)
      if (confirmation === 'opted_out') setNotice('Saved, but your number replied STOP, so no texts will arrive until you text START.')
      else if (confirmation === 'failed') setNotice("Saved. The confirmation text didn't go through — check Twilio.")
      else if (message) setNotice(message)
    } catch {
      setError("Couldn't save. Try again.")
    } finally {
      setSaving(false)
    }
  }

  const s = settings
  const smsOn = !!s?.smsConsent && s.sms.all

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 text-white">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-[#7C9BFF] hover:text-white">
          ← Back
        </button>
        <h1 className="text-xl font-bold">Admin notifications</h1>
      </div>
      <p className="mt-2 text-sm text-white/50">
        Texts carry only what happened, a count and a link into admin — never names, numbers, photos or messages. Your own notifications stay in
        Settings → Notifications.
      </p>

      {error && <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
      {notice && <p className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}

      {!s ? (
        !error && <p className="mt-6 text-sm text-white/40">Loading…</p>
      ) : (
        <div className="mt-5 space-y-4">
          <Section title="Texts go to">
            <div className="px-5 pt-2 pb-4 text-sm">
              {status?.phoneLast4 ? (
                <p>
                  Your sign-in number ending <span className="font-semibold">{status.phoneLast4}</span>
                </p>
              ) : (
                <p className="text-white/50">Your sign-in number</p>
              )}
              {status?.optedOut && (
                <p className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">
                  This number replied STOP, so no texts are sent. Text START{status.startNumber ? ` to ${status.startNumber}` : ' to Zylove'} to turn them back on.
                </p>
              )}
              {s.smsConsent ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-emerald-300">✓ Admin texts on</p>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => save({ consent: false }, 'Admin texts are off.')}
                    className="text-xs text-white/40 underline hover:text-white disabled:opacity-40"
                  >
                    Stop admin texts
                  </button>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <label className="flex items-start gap-3 text-white/70">
                    <input type="checkbox" checked={consentTicked} onChange={(e) => setConsentTicked(e.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-[#1B4FD8]" />
                    <span>{ADMIN_CONSENT_TEXT}</span>
                  </label>
                  <button
                    type="button"
                    disabled={!consentTicked || saving}
                    onClick={() => save({ consent: true }, 'Admin texts are on. A confirmation text is on its way.')}
                    className="rounded-xl bg-[#1B4FD8] px-4 py-2 text-sm font-semibold disabled:opacity-40"
                  >
                    Turn on admin texts
                  </button>
                </div>
              )}
            </div>
          </Section>

          <Section title="Master">
            <div className={row}>
              <span>
                <span className="block font-medium">All texts (SMS)</span>
                <span className="block text-xs text-white/40">Off silences every row below, urgent ones too.</span>
              </span>
              <Switch checked={s.sms.all} disabled={saving} label="All texts" onChange={(v) => save({ sms: { all: v } })} />
            </div>
          </Section>

          <Section title="Quiet hours (non-urgent only)">
            <div className={row}>
              <span>
                <span className="block font-medium">Quiet hours</span>
                <span className="block text-xs text-white/40">Held alerts arrive as one summary when they end. Urgent ones always come through.</span>
              </span>
              <Switch checked={s.quietHours.enabled} disabled={saving} label="Quiet hours" onChange={(v) => save({ quietHours: { enabled: v } })} />
            </div>
            <div className="flex gap-3 border-t border-white/5 px-5 py-3.5">
              <TimeSelect label="From" value={s.quietHours.from} disabled={saving || !s.quietHours.enabled} onChange={(v) => save({ quietHours: { from: v } })} />
              <TimeSelect label="Until" value={s.quietHours.until} disabled={saving || !s.quietHours.enabled} onChange={(v) => save({ quietHours: { until: v } })} />
            </div>
            <p className="px-5 pb-4 text-xs text-white/40">Central time</p>
          </Section>

          {ADMIN_ALERT_GROUPS.map((g) => (
            <Section key={g.title} title={g.title}>
              <div className="mt-2">
                {g.items.map((item) => (
                  <div key={item.key} className={row}>
                    <span className={`flex min-w-0 flex-wrap items-center gap-2 ${smsOn ? '' : 'text-white/40'}`}>
                      <span>{item.label}</span>
                      {item.urgent && <span className="rounded-full bg-[#E03131] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Urgent</span>}
                    </span>
                    <Switch
                      checked={s.sms.events[item.key]}
                      disabled={saving || !s.sms.all}
                      label={`${item.label} texts`}
                      onChange={(v) => save({ sms: { events: { [item.key]: v } } })}
                    />
                  </div>
                ))}
              </div>
            </Section>
          ))}

          <Section title="Excluded test accounts">
            <p className="px-5 pt-2 text-xs text-white/40">
              Never alerted about. Curated profiles, seed accounts and admins are always left out.
            </p>
            <ul className="mt-2">
              {s.excludedUids.map((u) => (
                <li key={u} className={row}>
                  <span className="min-w-0 truncate font-mono text-sm text-white/70">{u}</span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => save({ excludedUids: s.excludedUids.filter((x) => x !== u) })}
                    className="text-xs text-white/40 hover:text-white disabled:opacity-40"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="flex gap-2 border-t border-white/5 px-5 py-3.5"
              onSubmit={(e) => {
                e.preventDefault()
                const v = newUid.trim()
                if (!v || s.excludedUids.includes(v)) return
                void save({ excludedUids: [...s.excludedUids, v] }).then(() => setNewUid(''))
              }}
            >
              <input
                value={newUid}
                onChange={(e) => setNewUid(e.target.value)}
                placeholder="Account ID"
                aria-label="Account ID to exclude"
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-gray-900 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none"
              />
              <button type="submit" disabled={saving || !newUid.trim()} className="rounded-xl bg-white/10 px-4 py-2 text-sm font-medium disabled:opacity-40">
                Add
              </button>
            </form>
          </Section>

          <p className="px-1 text-xs text-white/40">
            Non-urgent texts: at most one per kind every 10 minutes (30 for new accounts and profiles) with a count, and 25 a day. Past that, one
            summary at 8 AM. Every change here is logged.
          </p>
        </div>
      )}
    </div>
  )
}
