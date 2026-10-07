import { type Unsubscribe } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'
import { saveSettings, subscribeSettingsView } from './privateSettings'
import { SMS_CONSENT_VERSION, type SmsConsentSource } from '../config/smsConsent'

export type SmsMode = 'spark' | 'play'

// private/settings smsNotifications = {
//   spark: { newSpark, newMessage, newMatch },
//   play:  { newFlame, newMessage, newMatch },
//   quietNudge,   // both modes
// }
export interface SmsPreferences {
  spark: { newSpark: boolean; newMessage: boolean; newMatch: boolean }
  play: { newFlame: boolean; newMessage: boolean; newMatch: boolean }
  quietNudge: boolean
}

export const SMS_SECTIONS: {
  mode: SmsMode
  title: string
  items: { key: string; label: string; description: string }[]
}[] = [
  {
    mode: 'spark',
    title: 'Spark notifications',
    items: [
      { key: 'newSpark', label: 'New Spark', description: 'Someone liked you in Spark' },
      { key: 'newMessage', label: 'New message', description: 'A new message in a Spark chat' },
      { key: 'newMatch', label: 'New match', description: 'You connected in Spark' },
    ],
  },
  {
    mode: 'play',
    title: 'Play notifications',
    items: [
      { key: 'newFlame', label: 'New Flame', description: 'Someone liked you in Play' },
      { key: 'newMessage', label: 'New message', description: 'A new message in a Play chat' },
      { key: 'newMatch', label: 'New entanglement', description: 'You connected in Play' },
    ],
  },
]

// Defaults written with consent. quietNudge stays off: the quiet chat nudge
// is in-app only for now (no SMS).
const DEFAULT_PREFERENCES: SmsPreferences = {
  spark: { newSpark: true, newMessage: true, newMatch: true },
  play: { newFlame: true, newMessage: true, newMatch: true },
  quietNudge: false,
}

// Settings saved before the Spark/Play split were flat ({ newSpark,
// newMessage, newMatch, quietNudge }); each missing mode key falls back to
// its flat equivalent, then the default.
function parsePreferences(raw: unknown): SmsPreferences {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  const section = (mode: SmsMode) => {
    const v = r[mode]
    return (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  }
  const spark = section('spark')
  const play = section('play')
  const d = DEFAULT_PREFERENCES
  return {
    spark: {
      newSpark: bool(spark.newSpark, bool(r.newSpark, d.spark.newSpark)),
      newMessage: bool(spark.newMessage, bool(r.newMessage, d.spark.newMessage)),
      newMatch: bool(spark.newMatch, bool(r.newMatch, d.spark.newMatch)),
    },
    play: {
      newFlame: bool(play.newFlame, bool(r.newSpark, d.play.newFlame)),
      newMessage: bool(play.newMessage, bool(r.newMessage, d.play.newMessage)),
      newMatch: bool(play.newMatch, bool(r.newMatch, d.play.newMatch)),
    },
    quietNudge: bool(r.quietNudge, d.quietNudge),
  }
}

export function sectionPreferences(p: SmsPreferences, mode: SmsMode): Record<string, boolean> {
  return mode === 'spark' ? p.spark : p.play
}

// private/settings smsQuietHours. Times are 'HH:MM' (24h) in `timezone`, the
// browser's zone when last saved; the server skips texts inside the window.
export interface QuietHours {
  enabled: boolean
  from: string
  until: string
  timezone: string
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'
  } catch {
    return 'America/Chicago'
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function defaultQuietHours(): QuietHours {
  return { enabled: true, from: '21:00', until: '08:00', timezone: browserTimezone() }
}

function parseQuietHours(v: unknown): QuietHours {
  const d = defaultQuietHours()
  if (typeof v !== 'object' || v === null) return d
  const q = v as Record<string, unknown>
  return {
    enabled: typeof q.enabled === 'boolean' ? q.enabled : d.enabled,
    from: typeof q.from === 'string' && HHMM.test(q.from) ? q.from : d.from,
    until: typeof q.until === 'string' && HHMM.test(q.until) ? q.until : d.until,
    timezone: typeof q.timezone === 'string' && q.timezone ? q.timezone : d.timezone,
  }
}

// One master switch per mode: private/settings smsNotificationsEnabled =
// { spark, play }. Older accounts hold one boolean, which counts for both
// modes until the next change rewrites it as the object.
export type SmsEnabled = Record<SmsMode, boolean>

function parseEnabled(v: unknown): SmsEnabled | null {
  if (typeof v === 'boolean') return { spark: v, play: v }
  if (typeof v !== 'object' || v === null) return null
  const e = v as Record<string, unknown>
  return { spark: e.spark === true, play: e.play === true }
}

export interface SmsSettings {
  // null: never set up (the field is missing), which drives the ⚙ dot.
  enabled: SmsEnabled | null
  // A consent record and no STOP since: switching a mode on needs no new opt-in.
  consented: boolean
  // They replied STOP (texts are off until they opt in again or text START).
  optedOut: boolean
  preferences: SmsPreferences
  quietHours: QuietHours
}

export function subscribeSmsSettings(uid: string, onChange: (s: SmsSettings) => void, onError: () => void): Unsubscribe {
  return subscribeSettingsView(
    uid,
    (d) => {
      const preferences = parsePreferences(d.smsNotifications)
      onChange({
        enabled: parseEnabled(d.smsNotificationsEnabled),
        consented: typeof d.smsConsent === 'object' && d.smsConsent !== null && d.smsOptOut == null,
        optedOut: d.smsOptOut != null,
        preferences,
        quietHours: parseQuietHours(d.smsQuietHours),
      })
    },
    onError,
  )
}

// What the server reports after an opt-in: the confirmation text went out,
// or the carrier still blocks the number after an earlier STOP (then `from`
// is our number, for them to text START to).
export interface SmsConsentResult {
  confirmation: 'sent' | 'opted_out' | 'failed'
  from: string | null
}

// First opt-in, from either mode's switch: records consent, turns that mode
// on (the other stays off), and saves the default preferences and quiet
// hours (on, 9pm–8am local), so texts respect the night from the start.
// Consent goes through the server, which records the verified sign-in phone,
// where it was given and which wording was shown (SMS_CONSENT_VERSION).
export async function grantSmsConsent(uid: string, mode: SmsMode, source: SmsConsentSource): Promise<SmsConsentResult> {
  const { data } = await httpsCallable<{ textVersion: string; source: SmsConsentSource }, SmsConsentResult>(
    functions,
    'grantSmsConsent',
  )({ textVersion: SMS_CONSENT_VERSION, source })
  await saveSettings(uid, {
    smsNotificationsEnabled: { spark: mode === 'spark', play: mode === 'play' },
    smsNotifications: DEFAULT_PREFERENCES,
    smsQuietHours: defaultQuietHours(),
  })
  return data
}

// Saves the whole quiet-hours object, re-stamping the browser's timezone.
export async function setQuietHours(uid: string, q: Omit<QuietHours, 'timezone'>): Promise<void> {
  await saveSettings(uid, { smsQuietHours: { ...q, timezone: browserTimezone() } })
}

// One mode's master switch. Writes the whole object, which also migrates an
// old single boolean (current carries its value for the other mode).
// Turning off keeps the preferences for next time.
export async function setSmsEnabled(uid: string, mode: SmsMode, enabled: boolean, current: SmsEnabled | null): Promise<void> {
  const next: SmsEnabled = { spark: current?.spark ?? false, play: current?.play ?? false, [mode]: enabled }
  await saveSettings(uid, { smsNotificationsEnabled: next })
}

// One toggle inside a mode section.
export async function setSmsPreference(uid: string, mode: SmsMode, key: string, value: boolean): Promise<void> {
  await saveSettings(uid, { smsNotifications: { [mode]: { [key]: value } } })
}

