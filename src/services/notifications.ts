import { doc, onSnapshot, serverTimestamp, updateDoc, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'

export type SmsPreference = 'newSpark' | 'newMessage' | 'newMatch' | 'quietNudge'

export const SMS_PREFERENCES: { key: SmsPreference; label: string; description: string }[] = [
  { key: 'newSpark', label: 'New Spark', description: 'Someone liked you' },
  { key: 'newMessage', label: 'New message', description: 'A new chat message' },
  { key: 'newMatch', label: 'New match', description: 'You both felt it' },
  { key: 'quietNudge', label: 'Quiet chat nudge', description: 'A conversation has gone quiet' },
]

// Defaults written with consent; quiet nudges start off.
const DEFAULT_PREFERENCES: Record<SmsPreference, boolean> = {
  newSpark: true,
  newMessage: true,
  newMatch: true,
  quietNudge: false,
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
  preferences: Record<SmsPreference, boolean>
  quietHours: QuietHours
}

export function subscribeSmsSettings(uid: string, onChange: (s: SmsSettings) => void, onError: () => void): Unsubscribe {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      const d = snap.data() ?? {}
      const raw = (typeof d.smsNotifications === 'object' && d.smsNotifications) || {}
      const preferences = Object.fromEntries(
        SMS_PREFERENCES.map(({ key }) => [key, typeof raw[key] === 'boolean' ? raw[key] : DEFAULT_PREFERENCES[key]]),
      ) as Record<SmsPreference, boolean>
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

export async function setSmsPreference(uid: string, key: SmsPreference, value: boolean): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { [`smsNotifications.${key}`]: value })
}
