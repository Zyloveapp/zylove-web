// Admin notifications, pure: the event catalog, the settings shape and its
// defaults, the batching / daily cap / quiet hours rules and every text.
// adminAlerts.ts does the reading, writing and sending.
//
// Texts carry only the event type, a count and a link into admin — never a
// name, phone number, age, location, photo, message or report text. GSM-7
// characters only (":" not "→"), so each text stays one 160-character segment.

import { inQuietHours } from './sms'

export type AdminEvent =
  | 'childSafety'
  | 'scamSuspend'
  | 'reportUrgent'
  | 'reportNew'
  | 'photoReview'
  | 'trustFlag'
  | 'appeal'
  | 'evidence'
  | 'evidenceExpiring'
  | 'newAccount'
  | 'profileCompleted'
  | 'deletionRequest'
  | 'founderMessage'
  | 'contactMessage'
  | 'paymentDispute'

// Trust flags have one toggle per reason family, not per reason.
export type TrustFamily = 'scam' | 'photo' | 'device' | 'contact' | 'other'
export const TRUST_FAMILIES: TrustFamily[] = ['scam', 'photo', 'device', 'contact', 'other']
const TRUST_TOGGLE: Record<TrustFamily, ToggleKey> = {
  scam: 'trustScam',
  photo: 'trustPhoto',
  device: 'trustDevice',
  contact: 'trustContact',
  other: 'trustOther',
}
const FAMILY_OF: Record<string, TrustFamily> = {
  scam_trap: 'scam',
  scam_reports: 'scam',
  duplicate_photo: 'photo',
  blocklist_photo: 'photo',
  ai_photo: 'photo',
  stolen_photo: 'photo',
  photo_rejections: 'photo',
  banned_device: 'device',
  banned_ip: 'device',
  shared_device: 'device',
  shared_ip: 'device',
  country_mismatch: 'device',
  contact_rush: 'contact',
  contact_fast: 'contact',
}
export const familyOf = (reasonKey: string): TrustFamily => FAMILY_OF[reasonKey] ?? 'other'

// The toggles, in the order the settings screen shows them.
export const TOGGLE_KEYS = [
  'childSafety',
  'scamSuspend',
  'reportUrgent',
  'reportNew',
  'photoReview',
  'trustPhoto',
  'trustDevice',
  'trustScam',
  'trustContact',
  'trustOther',
  'appeal',
  'evidence',
  'evidenceExpiring',
  'newAccount',
  'profileCompleted',
  'deletionRequest',
  'founderMessage',
  'contactMessage',
  'paymentDispute',
] as const
export type ToggleKey = (typeof TOGGLE_KEYS)[number]

const MIN = 60 * 1000
export const WINDOW_MS = 10 * MIN
export const SLOW_WINDOW_MS = 30 * MIN
export const DAILY_CAP = 25
export const CATCH_UP_HOUR = 8
// Urgent runaway guard: past this many of one urgent type in an hour, one
// text per URGENT_COLLAPSE_MS with a count.
export const URGENT_PER_HOUR = 10
export const URGENT_COLLAPSE_MS = 15 * MIN
export const CENTRAL = 'America/Chicago'

export type Detail = Record<string, number>

const ADMIN = 'zylove.app/admin'
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const verb = (n: number, one: string, many: string) => (n === 1 ? one : many)

function parts(detail: Detail, labels: [string, string][]): string {
  const xs = labels.filter(([k]) => (detail[k] ?? 0) > 0).map(([k, label]) => `${detail[k]} ${label}`)
  return xs.length ? ` (${xs.join(', ')})` : ''
}

interface EventDef {
  urgent: boolean
  windowMs: number
  // The text on its own. `minutes` is set when the count was batched.
  text: (n: number, detail: Detail, minutes: number | null) => string
  // The phrase in a summary ("2 photos to review").
  phrase: (n: number) => string
}

export const EVENTS: Record<AdminEvent, EventDef> = {
  childSafety: {
    urgent: true,
    windowMs: 0,
    text: (n) => `Zylove admin URGENT: ${plural(n, 'child-safety report')} ${verb(n, 'needs', 'need')} review now. ${ADMIN}/reports`,
    phrase: (n) => plural(n, 'child-safety report'),
  },
  scamSuspend: {
    urgent: true,
    windowMs: 0,
    text: (n) => `Zylove admin URGENT: ${plural(n, 'account')} hidden pending review for scam reports. ${ADMIN}/trust`,
    phrase: (n) => plural(n, 'scam hold'),
  },
  reportUrgent: {
    urgent: true,
    windowMs: 0,
    text: (n) => `Zylove admin URGENT: ${plural(n, 'urgent report')} (felt unsafe / aggressive). ${ADMIN}/reports`,
    phrase: (n) => plural(n, 'urgent report'),
  },
  evidenceExpiring: {
    urgent: true,
    windowMs: 0,
    text: (n) => `Zylove admin URGENT: ${plural(n, 'undecided evidence item')} will be deleted within 7 days. ${ADMIN}/locker`,
    phrase: (n) => plural(n, 'evidence item') + ' expiring',
  },
  reportNew: {
    urgent: false,
    windowMs: WINDOW_MS,
    text: (n) => `Zylove admin: ${plural(n, 'new report')}. ${ADMIN}/reports`,
    phrase: (n) => plural(n, 'new report'),
  },
  photoReview: {
    urgent: false,
    windowMs: WINDOW_MS,
    text: (n) => `Zylove admin: ${plural(n, 'photo')} ${verb(n, 'needs', 'need')} review. ${ADMIN}/photos`,
    phrase: (n) => `${plural(n, 'photo')} to review`,
  },
  trustFlag: {
    urgent: false,
    windowMs: WINDOW_MS,
    text: (n, d) =>
      `Zylove admin: ${plural(n, 'new trust flag')}${parts(d, [['scam', 'scam'], ['photo', 'photo'], ['device', 'device'], ['contact', 'contact'], ['other', 'other']])}. ${ADMIN}/trust`,
    phrase: (n) => plural(n, 'trust flag'),
  },
  appeal: {
    urgent: false,
    windowMs: WINDOW_MS,
    text: (n) => `Zylove admin: ${plural(n, 'new appeal')}. ${ADMIN}/locker?tab=appeals`,
    phrase: (n) => plural(n, 'appeal'),
  },
  evidence: {
    urgent: false,
    windowMs: WINDOW_MS,
    text: (n) => `Zylove admin: ${plural(n, 'new evidence submission')}. ${ADMIN}/locker`,
    phrase: (n) => plural(n, 'evidence submission'),
  },
  newAccount: {
    urgent: false,
    windowMs: SLOW_WINDOW_MS,
    text: (n, _d, minutes) => `Zylove admin: ${plural(n, 'new account')}${minutes ? ` in the last ${minutes} min` : ''}. ${ADMIN}/activity`,
    phrase: (n) => plural(n, 'new account'),
  },
  profileCompleted: {
    urgent: false,
    windowMs: SLOW_WINDOW_MS,
    text: (n, d) => `Zylove admin: ${plural(n, 'profile')} completed${parts(d, [['spark', 'Spark'], ['play', 'Play']])}. ${ADMIN}/activity`,
    phrase: (n) => `${plural(n, 'profile')} completed`,
  },
  deletionRequest: {
    urgent: false,
    windowMs: WINDOW_MS,
    text: (n) => `Zylove admin: ${plural(n, 'account deletion request')}. ${ADMIN}/deletions`,
    phrase: (n) => plural(n, 'deletion request'),
  },
  founderMessage: {
    urgent: false,
    windowMs: WINDOW_MS,
    text: (n) => `Zylove admin: ${plural(n, 'new founder message')}. ${ADMIN}/messages`,
    phrase: (n) => plural(n, 'founder message'),
  },
  contactMessage: {
    urgent: false,
    windowMs: WINDOW_MS,
    text: (n) => `Zylove admin: ${plural(n, 'new contact message')}. ${ADMIN}/contact`,
    phrase: (n) => plural(n, 'contact message'),
  },
  paymentDispute: {
    urgent: false,
    windowMs: WINDOW_MS,
    text: (n) => `Zylove admin: ${plural(n, 'payment dispute or refund', 'payment disputes or refunds')}. Check Stripe.`,
    phrase: (n) => plural(n, 'payment dispute'),
  },
}

// Summary order: safety first, so a trimmed summary keeps what matters most.
const SUMMARY_ORDER: AdminEvent[] = [
  'reportNew',
  'photoReview',
  'trustFlag',
  'appeal',
  'evidence',
  'paymentDispute',
  'deletionRequest',
  'founderMessage',
  'contactMessage',
  'newAccount',
  'profileCompleted',
]

export const CAP_NOTICE = `Zylove admin: daily text limit reached (${DAILY_CAP}). Non-urgent alerts paused until ${CATCH_UP_HOUR} AM; urgent ones still come through. ${ADMIN}`
export const ADMIN_SMS_CONFIRMATION =
  'Zylove admin alerts are on. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.'
export const ADMIN_CONSENT_VERSION = '2026-10-08'
export const ADMIN_CONSENT_TEXT =
  'Text me Zylove admin alerts (counts and links only). Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.'

// ─── Settings ────────────────────────────────────────────────────────────────

export interface QuietHours {
  enabled: boolean
  from: string
  until: string
  timezone: string
}
export interface ChannelSettings {
  all: boolean
  events: Record<ToggleKey, boolean>
}
export interface AdminNotifySettings {
  sms: ChannelSettings
  // Stored for the later web-push task; nothing reads it yet.
  push: ChannelSettings
  quietHours: QuietHours
  // Test accounts never alerted about (uids).
  excludedUids: string[]
  // The admin's own opt-in to admin texts; none = no texts.
  smsConsent: { at: number; version: string } | null
}

const allOn = () => Object.fromEntries(TOGGLE_KEYS.map((k) => [k, true])) as Record<ToggleKey, boolean>
export const DEFAULT_QUIET: QuietHours = { enabled: false, from: '22:00', until: '07:00', timezone: CENTRAL }
export const MAX_EXCLUDED = 50

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function channel(raw: unknown, allDefault: boolean): ChannelSettings {
  const c = isObj(raw) ? raw : {}
  const events = allOn()
  const ev = isObj(c.events) ? c.events : {}
  for (const k of TOGGLE_KEYS) if (typeof ev[k] === 'boolean') events[k] = ev[k] as boolean
  return { all: typeof c.all === 'boolean' ? c.all : allDefault, events }
}

// The stored doc (or nothing) with every gap filled by its default: a
// missing toggle is ON, so a new event type starts on.
export function normalizeSettings(raw: unknown): AdminNotifySettings {
  const r = isObj(raw) ? raw : {}
  const q = isObj(r.quietHours) ? r.quietHours : {}
  const consent = isObj(r.smsConsent) && typeof r.smsConsent.at === 'number' ? r.smsConsent : null
  return {
    sms: channel(r.sms, true),
    push: channel(r.push, false),
    quietHours: {
      enabled: q.enabled === true,
      from: typeof q.from === 'string' && HHMM.test(q.from) ? q.from : DEFAULT_QUIET.from,
      until: typeof q.until === 'string' && HHMM.test(q.until) ? q.until : DEFAULT_QUIET.until,
      timezone: validTimeZone(q.timezone) ? q.timezone : DEFAULT_QUIET.timezone,
    },
    excludedUids: Array.isArray(r.excludedUids) ? r.excludedUids.filter((u): u is string => typeof u === 'string' && !!u).slice(0, MAX_EXCLUDED) : [],
    smsConsent: consent ? { at: consent.at as number, version: typeof consent.version === 'string' ? consent.version : 'unknown' } : null,
  }
}

// A change from the settings screen, checked key by key. Throws a message
// for anything unknown or malformed (the callable turns it into an error).
export interface SettingsPatch {
  sms?: { all?: boolean; events?: Partial<Record<ToggleKey, boolean>> }
  push?: { all?: boolean; events?: Partial<Record<ToggleKey, boolean>> }
  quietHours?: Partial<QuietHours>
  excludedUids?: string[]
  consent?: boolean
}

export function parsePatch(raw: unknown): SettingsPatch {
  if (!isObj(raw)) throw new Error('Nothing to save')
  const out: SettingsPatch = {}
  for (const key of Object.keys(raw)) {
    if (!['sms', 'push', 'quietHours', 'excludedUids', 'consent'].includes(key)) throw new Error(`Unknown setting ${key}`)
  }
  for (const ch of ['sms', 'push'] as const) {
    const c = raw[ch]
    if (c === undefined) continue
    if (!isObj(c)) throw new Error(`Bad ${ch}`)
    const next: { all?: boolean; events?: Partial<Record<ToggleKey, boolean>> } = {}
    for (const k of Object.keys(c)) if (k !== 'all' && k !== 'events') throw new Error(`Unknown setting ${ch}.${k}`)
    if (c.all !== undefined) {
      if (typeof c.all !== 'boolean') throw new Error(`Bad ${ch}.all`)
      next.all = c.all
    }
    if (c.events !== undefined) {
      if (!isObj(c.events)) throw new Error(`Bad ${ch}.events`)
      next.events = {}
      for (const [k, v] of Object.entries(c.events)) {
        if (!(TOGGLE_KEYS as readonly string[]).includes(k) || typeof v !== 'boolean') throw new Error(`Bad ${ch}.events.${k}`)
        next.events[k as ToggleKey] = v
      }
    }
    out[ch] = next
  }
  if (raw.quietHours !== undefined) {
    const q = raw.quietHours
    if (!isObj(q)) throw new Error('Bad quietHours')
    const next: Partial<QuietHours> = {}
    for (const [k, v] of Object.entries(q)) {
      if (k === 'enabled' && typeof v === 'boolean') next.enabled = v
      else if ((k === 'from' || k === 'until') && typeof v === 'string' && HHMM.test(v)) next[k] = v
      else if (k === 'timezone' && validTimeZone(v)) next.timezone = v
      else throw new Error(`Bad quietHours.${k}`)
    }
    if (next.from !== undefined && next.from === next.until) throw new Error('Quiet hours need a start and end that differ')
    out.quietHours = next
  }
  if (raw.excludedUids !== undefined) {
    const xs = raw.excludedUids
    if (!Array.isArray(xs) || xs.length > MAX_EXCLUDED || !xs.every((u) => typeof u === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(u))) {
      throw new Error('Bad excludedUids')
    }
    out.excludedUids = [...new Set(xs as string[])]
  }
  if (raw.consent !== undefined) {
    if (typeof raw.consent !== 'boolean') throw new Error('Bad consent')
    out.consent = raw.consent
  }
  return out
}

// Applies a parsed patch; returns the new settings and what changed, as
// { 'sms.events.newAccount': [before, after] } — booleans, times and counts
// only, for the audit log.
export function applyPatch(
  current: AdminNotifySettings,
  patch: SettingsPatch,
  now: number,
): { next: AdminNotifySettings; changed: Record<string, [unknown, unknown]> } {
  const next: AdminNotifySettings = structuredClone(current)
  const changed: Record<string, [unknown, unknown]> = {}
  const set = (path: string, before: unknown, after: unknown) => {
    if (before !== after) changed[path] = [before, after]
  }
  for (const ch of ['sms', 'push'] as const) {
    const p = patch[ch]
    if (!p) continue
    if (p.all !== undefined) {
      set(`${ch}.all`, next[ch].all, p.all)
      next[ch].all = p.all
    }
    for (const [k, v] of Object.entries(p.events ?? {}) as [ToggleKey, boolean][]) {
      set(`${ch}.events.${k}`, next[ch].events[k], v)
      next[ch].events[k] = v
    }
  }
  if (patch.quietHours) {
    for (const [k, v] of Object.entries(patch.quietHours) as [keyof QuietHours, never][]) {
      set(`quietHours.${k}`, next.quietHours[k], v)
      ;(next.quietHours as unknown as Record<string, unknown>)[k] = v
    }
    if (next.quietHours.from === next.quietHours.until) throw new Error('Quiet hours need a start and end that differ')
  }
  if (patch.excludedUids) {
    const before = new Set(next.excludedUids)
    const after = new Set(patch.excludedUids)
    const added = [...after].filter((u) => !before.has(u)).length
    const removed = [...before].filter((u) => !after.has(u)).length
    if (added || removed) changed.excludedUids = [{ count: before.size }, { count: after.size, added, removed }]
    next.excludedUids = [...after]
  }
  if (patch.consent !== undefined) {
    const had = next.smsConsent !== null
    if (patch.consent && !had) next.smsConsent = { at: now, version: ADMIN_CONSENT_VERSION }
    if (!patch.consent) next.smsConsent = null
    set('smsConsent', had, patch.consent)
  }
  return { next, changed }
}

// ─── Which events an admin gets ──────────────────────────────────────────────

export interface QueuedEvent {
  type: AdminEvent
  n: number
  detail: Detail
  // Trust flags: the flag's reason keys (each admin's families decide).
  reasons?: string[]
  // Who it's about (a report's reported person): urgent texts count once per
  // person per hour (F-070), so one account can't be reported into a flood.
  about?: string
}

// The event as this admin's SMS settings allow it, or null when it's off:
// no consent, SMS master off, or the event's toggle off. A trust flag counts
// under the first of its reason families that's on (scam, photo, device,
// contact, other), so turning one family off never hides a flag that
// another reason also raised.
export function smsEventFor(settings: AdminNotifySettings, ev: QueuedEvent): { n: number; detail: Detail } | null {
  if (!settings.smsConsent || !settings.sms.all || ev.n <= 0) return null
  if (ev.type === 'trustFlag') {
    const families = new Set((ev.reasons ?? []).map(familyOf))
    const fam = TRUST_FAMILIES.find((f) => families.has(f) && settings.sms.events[TRUST_TOGGLE[f]])
    return fam ? { n: ev.n, detail: { [fam]: ev.n } } : null
  }
  return settings.sms.events[ev.type as ToggleKey] ? { n: ev.n, detail: ev.detail } : null
}

// ─── Batching, cap, quiet hours ──────────────────────────────────────────────

export interface TypeState {
  pending: number
  detail: Detail
  // When the oldest pending one arrived, and when this type last texted.
  since: number | null
  lastSentAt: number | null
}
export interface AdminNotifyState {
  types: Partial<Record<AdminEvent, TypeState>>
  // Non-urgent texts sent on `date` (Central).
  day: { date: string; sent: number }
  // Over the daily cap: non-urgent texts held until then.
  pausedUntil: number | null
  // Quiet hours were on at the last check (their end sends the summary).
  quiet: boolean
  // Urgent texts per type in the last hour (the runaway guard).
  urgentTimes: Partial<Record<AdminEvent, number[]>>
  // F-070: when each person last had an urgent text about them (last hour).
  urgentAbout: Record<string, number>
}

export function emptyState(): AdminNotifyState {
  return { types: {}, day: { date: '', sent: 0 }, pausedUntil: null, quiet: false, urgentTimes: {}, urgentAbout: {} }
}

export function normalizeState(raw: unknown): AdminNotifyState {
  const s = emptyState()
  if (!isObj(raw)) return s
  if (isObj(raw.types)) {
    for (const [k, v] of Object.entries(raw.types)) {
      if (!(k in EVENTS) || !isObj(v)) continue
      s.types[k as AdminEvent] = {
        pending: typeof v.pending === 'number' ? v.pending : 0,
        detail: isObj(v.detail) ? (v.detail as Detail) : {},
        since: typeof v.since === 'number' ? v.since : null,
        lastSentAt: typeof v.lastSentAt === 'number' ? v.lastSentAt : null,
      }
    }
  }
  if (isObj(raw.day) && typeof raw.day.date === 'string' && typeof raw.day.sent === 'number') s.day = { date: raw.day.date, sent: raw.day.sent }
  s.pausedUntil = typeof raw.pausedUntil === 'number' ? raw.pausedUntil : null
  s.quiet = raw.quiet === true
  if (isObj(raw.urgentTimes)) {
    for (const [k, v] of Object.entries(raw.urgentTimes)) {
      if (k in EVENTS && Array.isArray(v)) s.urgentTimes[k as AdminEvent] = v.filter((t): t is number => typeof t === 'number')
    }
  }
  if (isObj(raw.urgentAbout)) {
    for (const [k, v] of Object.entries(raw.urgentAbout)) if (typeof v === 'number') s.urgentAbout[k] = v
  }
  return s
}

// "2026-10-08", Central.
export function centralDate(now: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CENTRAL, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
}

// The next 8:00 AM Central after `now`.
export function nextCatchUp(now: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now))
  const cur = Number(p.find((x) => x.type === 'hour')?.value) * 60 + Number(p.find((x) => x.type === 'minute')?.value)
  const target = CATCH_UP_HOUR * 60
  const delta = cur < target ? target - cur : 24 * 60 - cur + target
  return now - (now % MIN) + delta * MIN
}

function typeState(s: AdminNotifyState, type: AdminEvent): TypeState {
  return (s.types[type] ??= { pending: 0, detail: {}, since: null, lastSentAt: null })
}

function addPending(t: TypeState, n: number, detail: Detail, now: number) {
  t.pending += n
  for (const [k, v] of Object.entries(detail)) t.detail[k] = (t.detail[k] ?? 0) + v
  t.since ??= now
}

function take(t: TypeState, now: number): { n: number; detail: Detail; since: number | null } {
  const out = { n: t.pending, detail: t.detail, since: t.since }
  t.pending = 0
  t.detail = {}
  t.since = null
  t.lastSentAt = now
  return out
}

function rollDay(s: AdminNotifyState, now: number) {
  const today = centralDate(now)
  if (s.day.date !== today) s.day = { date: today, sent: 0 }
}

export interface Outcome {
  state: AdminNotifyState
  texts: string[]
}

// At the daily cap: the cap notice (once) and every non-urgent text holds
// until 8 AM. Returns whether it's capped.
function atCap(s: AdminNotifyState, now: number, texts: string[]): boolean {
  liftPause(s, now)
  if (s.day.sent < DAILY_CAP) return false
  if (s.pausedUntil === null) {
    s.pausedUntil = nextCatchUp(now)
    texts.push(CAP_NOTICE)
  }
  return true
}

// F-070: when the cap's pause ends (8 AM) the day's count starts again — a
// cap hit before 8 AM left the count at the cap for the rest of that day, so
// the first text after 8 AM paused everything again until the next morning.
function liftPause(s: AdminNotifyState, now: number) {
  if (s.pausedUntil !== null && now >= s.pausedUntil) {
    s.pausedUntil = null
    s.day = { date: centralDate(now), sent: 0 }
  }
}

function nonUrgentHeld(s: AdminNotifyState, settings: AdminNotifySettings, now: number): boolean {
  if (inQuietHours(settings.quietHours, new Date(now))) {
    s.quiet = true
    return true
  }
  return s.pausedUntil !== null && now < s.pausedUntil
}

function sendType(s: AdminNotifyState, type: AdminEvent, now: number, texts: string[]) {
  if (atCap(s, now, texts)) return
  const t = typeState(s, type)
  // Batched = more than the one event that arrived just now.
  const batched = t.lastSentAt !== null && t.since !== null && t.since < now
  const minutes = batched ? Math.max(1, Math.ceil((now - (t.lastSentAt as number)) / MIN)) : null
  const { n, detail } = take(t, now)
  s.day.sent++
  texts.push(EVENTS[type].text(n, detail, minutes))
}

// An event arrives (already filtered by smsEventFor).
export function onEvent(stateIn: AdminNotifyState, settings: AdminNotifySettings, type: AdminEvent, n: number, detail: Detail, now: number, about?: string): Outcome {
  const s = structuredClone(stateIn)
  const texts: string[] = []
  rollDay(s, now)
  const t = typeState(s, type)

  if (EVENTS[type].urgent) {
    for (const [k, at] of Object.entries(s.urgentAbout)) if (now - at >= 60 * MIN) delete s.urgentAbout[k]
    // F-070: someone already texted about this hour isn't again (nor counted
    // — the first text's link shows every report about them).
    if (about && s.urgentAbout[about] !== undefined) return { state: s, texts }
    if (about) s.urgentAbout[about] = now
    addPending(t, n, detail, now)
    const recent = (s.urgentTimes[type] ?? []).filter((at) => now - at < 60 * MIN)
    const collapsed = recent.length >= URGENT_PER_HOUR
    if (!collapsed || t.lastSentAt === null || now - t.lastSentAt >= URGENT_COLLAPSE_MS) {
      const { n: count, detail: d } = take(t, now)
      texts.push(EVENTS[type].text(count, d, null))
      recent.push(now)
    }
    s.urgentTimes[type] = recent
    return { state: s, texts }
  }

  addPending(t, n, detail, now)
  if (nonUrgentHeld(s, settings, now)) return { state: s, texts }
  if (t.lastSentAt === null || now - t.lastSentAt >= EVENTS[type].windowMs) sendType(s, type, now, texts)
  return { state: s, texts }
}

// One summary of everything held ("overnight" after quiet hours, "since
// last night" after the cap), trimmed to one segment.
export function summaryText(lead: string, counts: [AdminEvent, number][]): string {
  const ordered = SUMMARY_ORDER.map((type) => counts.find(([t]) => t === type)).filter((c): c is [AdminEvent, number] => !!c && c[1] > 0)
  const tail = `. ${ADMIN}`
  const phrases = ordered.map(([type, n]) => EVENTS[type].phrase(n))
  for (let keep = phrases.length; keep > 0; keep--) {
    const body = `Zylove admin ${lead}: ${phrases.slice(0, keep).join(', ')}${keep < phrases.length ? ', + more' : ''}${tail}`
    if (body.length <= 160) return body
  }
  return `Zylove admin ${lead}: new alerts${tail}`
}

function sendSummary(s: AdminNotifyState, lead: string, now: number, texts: string[]) {
  const held = Object.entries(s.types).some(([type, t]) => !EVENTS[type as AdminEvent].urgent && (t as TypeState).pending > 0)
  if (!held || atCap(s, now, texts)) return
  const counts: [AdminEvent, number][] = []
  for (const [type, t] of Object.entries(s.types) as [AdminEvent, TypeState][]) {
    if (EVENTS[type].urgent || t.pending <= 0) continue
    counts.push([type, take(t, now).n])
  }
  if (counts.length === 0) return
  s.day.sent++
  texts.push(summaryText(lead, counts))
}

// Every 5 minutes: batched counts whose window has passed, collapsed urgent
// ones, and the summary when quiet hours or the cap pause end.
export function flush(stateIn: AdminNotifyState, settings: AdminNotifySettings, now: number): Outcome {
  const s = structuredClone(stateIn)
  const texts: string[] = []
  rollDay(s, now)

  for (const [type, t] of Object.entries(s.types) as [AdminEvent, TypeState][]) {
    if (EVENTS[type].urgent && t.pending > 0 && (t.lastSentAt === null || now - t.lastSentAt >= URGENT_COLLAPSE_MS)) {
      const { n, detail } = take(t, now)
      texts.push(EVENTS[type].text(n, detail, null))
      ;(s.urgentTimes[type] ??= []).push(now)
    }
  }
  for (const type of Object.keys(s.urgentTimes) as AdminEvent[]) {
    s.urgentTimes[type] = (s.urgentTimes[type] ?? []).filter((at) => now - at < 60 * MIN)
  }

  const wasQuiet = s.quiet
  if (inQuietHours(settings.quietHours, new Date(now))) {
    s.quiet = true
    return { state: s, texts }
  }
  s.quiet = false
  if (s.pausedUntil !== null && now < s.pausedUntil) return { state: s, texts }
  if (s.pausedUntil !== null) {
    liftPause(s, now)
    sendSummary(s, 'since last night', now, texts)
    return { state: s, texts }
  }
  if (wasQuiet) {
    sendSummary(s, 'overnight', now, texts)
    return { state: s, texts }
  }
  for (const [type, t] of Object.entries(s.types) as [AdminEvent, TypeState][]) {
    if (EVENTS[type].urgent || t.pending <= 0) continue
    if (t.lastSentAt !== null && now - t.lastSentAt < EVENTS[type].windowMs) continue
    if (s.pausedUntil !== null) break
    sendType(s, type, now, texts)
  }
  return { state: s, texts }
}
