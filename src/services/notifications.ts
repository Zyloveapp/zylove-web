import { doc, onSnapshot, serverTimestamp, updateDoc, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'

export type SmsMode = 'spark' | 'play'

// users/{uid}.smsNotifications = {
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

// Defaults written with consent; quiet nudges start off.
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

// users/{uid}.smsQuietHours. Times are 'HH:MM' (24h) in `timezone`, the
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

export interface SmsSettings {
  // null: never set up (the field is missing), which drives the ⚙ dot.
  enabled: boolean | null
  consented: boolean
  preferences: SmsPreferences
  quietHours: QuietHours
}

export function subscribeSmsSettings(uid: string, onChange: (s: SmsSettings) => void, onError: () => void): Unsubscribe {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      const d = snap.data() ?? {}
      const preferences = parsePreferences(d.smsNotifications)
      onChange({
        enabled: typeof d.smsNotificationsEnabled === 'boolean' ? d.smsNotificationsEnabled : null,
        consented: typeof d.smsConsent === 'object' && d.smsConsent !== null,
        preferences,
        quietHours: parseQuietHours(d.smsQuietHours),
      })
    },
    onError,
  )
}

// First opt-in: records consent, the default preferences and default quiet
// hours (on, 9pm–8am local), so texts respect the night from the start.
export async function grantSmsConsent(uid: string, phone: string): Promise<void> {
  await updateDoc(doc(db, 'users', uid), {
    smsNotificationsEnabled: true,
    smsConsent: { grantedAt: serverTimestamp(), phone },
    smsNotifications: DEFAULT_PREFERENCES,
    smsQuietHours: defaultQuietHours(),
  })
}

// Saves the whole quiet-hours object, re-stamping the browser's timezone.
export async function setQuietHours(uid: string, q: Omit<QuietHours, 'timezone'>): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { smsQuietHours: { ...q, timezone: browserTimezone() } })
}

// Turning off keeps the preferences for next time.
export async function setSmsEnabled(uid: string, enabled: boolean): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { smsNotificationsEnabled: enabled })
}

// One toggle inside a mode section.
export async function setSmsPreference(uid: string, mode: SmsMode, key: string, value: boolean): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { [`smsNotifications.${mode}.${key}`]: value })
}

// A section's master toggle: sets all three of that mode's toggles.
export async function setSmsSection(uid: string, mode: SmsMode, value: boolean): Promise<void> {
  const keys = SMS_SECTIONS.find((s) => s.mode === mode)?.items.map((i) => i.key) ?? []
  await updateDoc(doc(db, 'users', uid), Object.fromEntries(keys.map((k) => [`smsNotifications.${mode}.${k}`, value])))
}

export async function setQuietNudge(uid: string, value: boolean): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { 'smsNotifications.quietNudge': value })
}
