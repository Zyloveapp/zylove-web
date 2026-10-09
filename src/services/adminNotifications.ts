import { doc, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'

// Admin notifications (functions/src/adminAlerts.ts). The admin reads their
// own settings doc directly (rules: admin claim + own uid); every change goes
// through adminSetNotificationSettings, which checks it and logs it.

// Screen order; keep in step with TOGGLE_KEYS in functions/src/adminAlertsCore.ts.
export const ADMIN_ALERT_GROUPS: { title: string; items: { key: AdminToggle; label: string; urgent?: boolean }[] }[] = [
  {
    title: 'Safety & reports',
    items: [
      { key: 'childSafety', label: 'Child-safety report', urgent: true },
      { key: 'scamSuspend', label: 'Scam reports: account hidden pending review', urgent: true },
      { key: 'reportUrgent', label: 'Urgent report (felt unsafe / aggressive)', urgent: true },
      { key: 'reportNew', label: 'New report' },
    ],
  },
  { title: 'Photos', items: [{ key: 'photoReview', label: 'Photo needs review' }] },
  {
    title: 'Trust flags',
    items: [
      { key: 'trustPhoto', label: 'Photo flags (duplicate, blocklist, AI, stolen)' },
      { key: 'trustDevice', label: 'Device & location (banned or shared device / IP, country mismatch)' },
      { key: 'trustScam', label: 'Scam signals (scam trap, scam reports)' },
      { key: 'trustContact', label: 'Contact rush' },
      { key: 'trustOther', label: 'Reports, reviews & behaviour (everything else)' },
    ],
  },
  {
    title: 'Appeals & evidence',
    items: [
      { key: 'appeal', label: 'Appeal submitted' },
      { key: 'evidence', label: 'Evidence submitted' },
      { key: 'evidenceExpiring', label: 'Undecided evidence expiring in 7 days', urgent: true },
    ],
  },
  {
    title: 'Account & system',
    items: [
      { key: 'newAccount', label: 'New account created' },
      { key: 'profileCompleted', label: 'Profile completed (Spark / Play)' },
      { key: 'deletionRequest', label: 'Account deletion requested' },
      { key: 'founderMessage', label: 'Founder message' },
      { key: 'contactMessage', label: 'Contact form message' },
      { key: 'paymentDispute', label: 'Payment dispute / refund' },
    ],
  },
]

export type AdminToggle =
  | 'childSafety'
  | 'scamSuspend'
  | 'reportUrgent'
  | 'reportNew'
  | 'photoReview'
  | 'trustPhoto'
  | 'trustDevice'
  | 'trustScam'
  | 'trustContact'
  | 'trustOther'
  | 'appeal'
  | 'evidence'
  | 'evidenceExpiring'
  | 'newAccount'
  | 'profileCompleted'
  | 'deletionRequest'
  | 'founderMessage'
  | 'contactMessage'
  | 'paymentDispute'

export interface AdminNotificationSettings {
  sms: { all: boolean; events: Record<AdminToggle, boolean> }
  quietHours: { enabled: boolean; from: string; until: string; timezone: string }
  excludedUids: string[]
  smsConsent: { at: number; version: string } | null
}

export const ADMIN_CONSENT_TEXT =
  'Text me Zylove admin alerts (counts and links only). Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.'

const ALL_KEYS = ADMIN_ALERT_GROUPS.flatMap((g) => g.items.map((i) => i.key))

// The same defaults as the server: a missing toggle is on.
function normalize(raw: Record<string, unknown> | undefined): AdminNotificationSettings {
  const sms = (raw?.sms ?? {}) as { all?: unknown; events?: Record<string, unknown> }
  const q = (raw?.quietHours ?? {}) as Record<string, unknown>
  const consent = raw?.smsConsent as { at?: unknown; version?: unknown } | null | undefined
  return {
    sms: {
      all: typeof sms.all === 'boolean' ? sms.all : true,
      events: Object.fromEntries(ALL_KEYS.map((k) => [k, typeof sms.events?.[k] === 'boolean' ? (sms.events[k] as boolean) : true])) as Record<AdminToggle, boolean>,
    },
    quietHours: {
      enabled: q.enabled === true,
      from: typeof q.from === 'string' ? q.from : '22:00',
      until: typeof q.until === 'string' ? q.until : '07:00',
      timezone: typeof q.timezone === 'string' ? q.timezone : 'America/Chicago',
    },
    excludedUids: Array.isArray(raw?.excludedUids) ? (raw.excludedUids as unknown[]).filter((u): u is string => typeof u === 'string') : [],
    smsConsent: consent && typeof consent.at === 'number' ? { at: consent.at, version: String(consent.version ?? '') } : null,
  }
}

export function subscribeAdminNotificationSettings(uid: string, onData: (s: AdminNotificationSettings) => void, onError: () => void): () => void {
  return onSnapshot(
    doc(db, 'adminNotificationSettings', uid),
    (snap) => onData(normalize(snap.data())),
    () => onError(),
  )
}

export interface SettingsPatch {
  sms?: { all?: boolean; events?: Partial<Record<AdminToggle, boolean>> }
  quietHours?: Partial<AdminNotificationSettings['quietHours']>
  excludedUids?: string[]
  consent?: boolean
}

// 'sent' | 'opted_out' | 'failed' for the opt-in confirmation text, else null.
export async function saveAdminNotificationSettings(patch: SettingsPatch): Promise<{ confirmation: string | null }> {
  const { data } = await httpsCallable<SettingsPatch, { ok: true; confirmation: string | null }>(functions, 'adminSetNotificationSettings')(patch)
  return { confirmation: data.confirmation }
}

export interface AdminSmsStatus {
  phoneLast4: string | null
  optedOut: boolean
  startNumber: string | null
}

export async function getAdminSmsStatus(): Promise<AdminSmsStatus> {
  const { data } = await httpsCallable<void, AdminSmsStatus>(functions, 'adminNotificationStatus')()
  return data
}
