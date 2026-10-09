// SMS notifications via Twilio's REST API. Nothing here throws: a failed or
// skipped text must never break the flow that triggered it.
//
// Every text goes to an SmsTarget, which only smsTarget() hands out: the
// person has a consent record, hasn't opted out, has that kind of text on and
// isn't in quiet hours. deliver() then checks the opt-out registry
// (smsOptOuts/{phone}, server-only) right before each send.

import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { loadPlayName } from './playName'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { internalRef, loadAccount, loadSettings, userRef } from './userData'

const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID')
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN')
const twilioFromNumber = defineSecret('TWILIO_FROM_NUMBER')

// Bind these on every function that calls sendSMS.
export const SMS_SECRETS = [twilioAccountSid, twilioAuthToken, twilioFromNumber]

// The inbound webhook checks Twilio's signature with the auth token.
export const TWILIO_AUTH_TOKEN = twilioAuthToken

// Lookup only needs the account credentials.
export const LOOKUP_SECRETS = [twilioAccountSid, twilioAuthToken]

// Twilio Lookup v2 line type ('mobile', 'landline', 'fixedVoip',
// 'nonFixedVoip', 'tollFree', 'personal', …) or null when unknown or the
// lookup failed. Callers treat null as "allow". ~$0.01 per call.
export async function lookupLineType(phoneNumber: string): Promise<string | null> {
  try {
    const sid = twilioAccountSid.value()
    const token = twilioAuthToken.value()
    if (!sid || !token) {
      logger.warn('lookupLineType: Twilio secrets not configured, skipping')
      return null
    }
    const url = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phoneNumber)}?Fields=line_type_intelligence`
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      logger.warn('lookupLineType: Twilio Lookup error', { status: res.status })
      return null
    }
    const body: unknown = await res.json()
    const lti =
      typeof body === 'object' && body !== null && 'line_type_intelligence' in body
        ? (body as { line_type_intelligence: unknown }).line_type_intelligence
        : null
    const type = typeof lti === 'object' && lti !== null && 'type' in lti ? (lti as { type: unknown }).type : null
    return typeof type === 'string' ? type : null
  } catch (err) {
    logger.warn('lookupLineType failed', { message: err instanceof Error ? err.message : String(err) })
    return null
  }
}

// 'billing' (a failed payment), 'founder' (your founder spot is at risk or
// changed) and 'account' (moderation and account notices) have no toggle of
// their own: on with the master switch.
export type SmsPreference = 'newSpark' | 'newMessage' | 'newMatch' | 'quietNudge' | 'billing' | 'founder' | 'account'
export type SmsMode = 'spark' | 'play'

// private/settings smsNotificationsEnabled = { spark, play } — one master switch
// per mode. Accounts from before the split hold a single boolean, which
// counts for both modes (Settings migrates it on the next change).
export function smsEnabledFor(enabled: unknown, mode: SmsMode): boolean {
  if (typeof enabled === 'boolean') return enabled
  return typeof enabled === 'object' && enabled !== null && (enabled as Record<string, unknown>)[mode] === true
}

// private/settings smsNotifications = {
//   spark: { newSpark, newMessage, newMatch },
//   play:  { newFlame, newMessage, newMatch },
//   quietNudge,
// }
// A Play like is a "Flame", so newSpark reads play.newFlame. Settings saved
// before the split were flat ({ newSpark, newMessage, newMatch, quietNudge });
// a missing mode key falls back to the flat one.
export function smsPreferenceOn(prefs: unknown, preference: SmsPreference, mode: SmsMode): boolean {
  if (preference === 'billing' || preference === 'founder' || preference === 'account') return true
  if (typeof prefs !== 'object' || prefs === null) return false
  const p = prefs as Record<string, unknown>
  if (preference === 'quietNudge') return p.quietNudge === true
  const section = p[mode]
  const key = mode === 'play' && preference === 'newSpark' ? 'newFlame' : preference
  const value = typeof section === 'object' && section !== null ? (section as Record<string, unknown>)[key] : undefined
  return typeof value === 'boolean' ? value : p[preference] === true
}

const E164 = /^\+[1-9]\d{6,14}$/

// Twilio: "Attempt to send to unsubscribed recipient" (they replied STOP).
const TWILIO_UNSUBSCRIBED = 21610

// ─── Consent ─────────────────────────────────────────────────────────────────

// The opt-in wording by version, stored with each consent record. Keep in
// step with src/config/smsConsent.ts (the client shows the text, the server
// records it from here, never from the client). 'legacy' is the pop-up before
// 2026-10-06, for clients still running the old build.
export const SMS_CONSENT_TEXTS: Record<string, string> = {
  '2026-10-07':
    'Text me match, message and account notifications from Zylove. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. See SMS Terms.',
  legacy:
    "Get Zylove updates by text. Turn on texts to be notified when founder spots open, get match alerts and never miss a message. We'll text you when something important happens — a new Spark, a message, a match. Standard rates apply. You can turn this off anytime. Message frequency varies. Reply STOP to opt out, HELP for help.",
}
export const SMS_CONSENT_SOURCES = ['settings', 'onboarding'] as const
export type SmsConsentSource = (typeof SMS_CONSENT_SOURCES)[number]

// Sent once, right after someone opts in.
export const SMS_CONFIRMATION =
  "Zylove: You're signed up for match, message and account notifications. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out."

// ─── Opt-outs ────────────────────────────────────────────────────────────────

// smsOptOuts/{E.164 phone}: replied STOP, or Twilio refused the number as
// unsubscribed. Server-only (rules: default deny). Nothing is sent to a number
// listed here; START (smsInbound.ts) or a new opt-in in the app removes it.
export const optOutRef = (phone: string) => getFirestore().doc(`smsOptOuts/${phone}`)

export async function recordOptOut(phone: string, source: 'stop' | 'carrier', keyword?: string): Promise<void> {
  await optOutRef(phone).set({ optedOutAt: FieldValue.serverTimestamp(), source, ...(keyword ? { keyword } : {}) })
}

// Our sending number (shown when someone must text START to it), or null.
export function smsFromNumber(): string | null {
  try {
    return twilioFromNumber.value() || null
  } catch {
    return null
  }
}

export type Delivery = 'sent' | 'opted_out' | 'failed'

// Sends one text unless the number is in the opt-out registry. Fails closed:
// if the registry can't be read, nothing is sent.
async function deliver(to: string, body: string): Promise<Delivery> {
  try {
    const sid = twilioAccountSid.value()
    const token = twilioAuthToken.value()
    const from = twilioFromNumber.value()
    if (!sid || !token || !from) {
      logger.warn('sendSMS: Twilio secrets not configured, skipping')
      return 'failed'
    }
    if (!E164.test(to)) {
      logger.warn('sendSMS: recipient is not an E.164 number, skipping')
      return 'failed'
    }
    if ((await optOutRef(to).get()).exists) {
      logger.info('sendSMS: skipped — number opted out')
      return 'opted_out'
    }
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    })
    if (!response.ok) {
      // Twilio's error body names the problem (bad number, opted out via STOP…).
      const detail = await response.text().catch(() => '')
      let code: unknown = null
      try {
        code = (JSON.parse(detail) as { code?: unknown }).code
      } catch {
        // Not JSON; only the status is logged.
      }
      if (code === TWILIO_UNSUBSCRIBED) {
        // Replied STOP before the inbound webhook existed, or it missed it.
        await recordOptOut(to, 'carrier').catch(() => {})
        logger.info('sendSMS: Twilio reports the number unsubscribed; recorded the opt-out')
        return 'opted_out'
      }
      // F-088: only Twilio's code and the HTTP status — the error text can quote the destination number.
      logger.error('sendSMS: Twilio rejected the message', {
        status: response.status,
        code: typeof code === 'number' || typeof code === 'string' ? code : null,
      })
      return 'failed'
    }
    logger.info('sendSMS: sent')
    return 'sent'
  } catch (err) {
    logger.error('sendSMS failed', { message: err instanceof Error ? err.message : String(err) })
    return 'failed'
  }
}

// Sends one text to a checked target. Returns whether Twilio accepted it.
export async function sendSMS(target: SmsTarget, body: string): Promise<boolean> {
  return (await deliver(target.phone, body)) === 'sent'
}

// The opt-in confirmation, straight after consent was recorded (the master
// switch and quiet hours don't apply: they just asked for texts).
export async function sendConsentConfirmation(phone: string): Promise<Delivery> {
  return deliver(phone, SMS_CONFIRMATION)
}

// Admin alert texts (adminAlerts.ts) go to an admin's own verified sign-in
// number. They don't read the user SMS settings (the admin opted in to admin
// texts on the Admin notifications screen), but STOP still stops them: deliver()
// checks the opt-out registry before every send.
export async function textAdmin(uid: string, body: string): Promise<Delivery> {
  const user = await getAuth().getUser(uid).catch(() => null)
  if (user?.customClaims?.admin !== true || !user.phoneNumber) return 'failed'
  return deliver(user.phoneNumber, body)
}

// For the settings screen: the admin's sign-in number and whether it replied STOP.
export async function adminSmsStatus(uid: string): Promise<{ phone: string | null; optedOut: boolean }> {
  const phone = (await getAuth().getUser(uid).catch(() => null))?.phoneNumber ?? null
  return { phone, optedOut: phone ? (await optOutRef(phone).get()).exists : false }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function toMinutes(hhmm: unknown): number | null {
  const m = typeof hhmm === 'string' ? HHMM.exec(hhmm) : null
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

// Minutes past midnight right now in the given IANA timezone, or null if the
// zone isn't valid.
function localMinutes(timeZone: string, now: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
    const hour = Number(parts.find((p) => p.type === 'hour')?.value)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value)
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null
  } catch {
    return null
  }
}

// private/settings smsQuietHours = { enabled, from: 'HH:MM', until: 'HH:MM', timezone }.
// The window includes `from` and excludes `until`; one that crosses midnight
// (21:00 → 08:00) wraps. Anything malformed means no quiet hours.
export function inQuietHours(quiet: unknown, now = new Date()): boolean {
  if (typeof quiet !== 'object' || quiet === null) return false
  const q = quiet as Record<string, unknown>
  if (q.enabled !== true) return false
  const from = toMinutes(q.from)
  const until = toMinutes(q.until)
  if (from === null || until === null || from === until) return false
  const current = localMinutes(typeof q.timezone === 'string' && q.timezone ? q.timezone : 'America/Chicago', now)
  if (current === null) return false
  return from < until ? current >= from && current < until : current >= from || current < until
}

declare const checked: unique symbol

// Only smsTarget() makes one, so sendSMS can't be handed an unchecked number.
export interface SmsTarget {
  uid: string
  phone: string
  user: DocumentData
  readonly [checked]: true
}

// Where to text the user, or null when this text mustn't go: no consent
// record, opted out (STOP), SMS off for the mode, this kind of text off, or
// quiet hours. The number is the one recorded with consent (the verified
// sign-in number at the time); if the sign-in number has since changed, no
// text until they opt in again. Preferences live in private/settings,
// consent and opt-out in private/account (userData.ts).
export async function smsTarget(uid: string, preference: SmsPreference, mode: SmsMode = 'spark'): Promise<SmsTarget | null> {
  try {
    const user = (await userRef(uid).get()).data()
    if (!user) return null
    const [settings, account] = await Promise.all([loadSettings(uid, user), loadAccount(uid, user)])
    const consent: unknown = account.smsConsent
    if (typeof consent !== 'object' || consent === null) return null
    if (account.smsOptOut != null) return null
    if (!smsEnabledFor(settings.smsNotificationsEnabled, mode) || !smsPreferenceOn(settings.smsNotifications, preference, mode)) {
      return null
    }
    if (inQuietHours(settings.smsQuietHours)) {
      logger.info('Skipped — quiet hours', { preference, mode })
      return null
    }
    const consentPhone: unknown = (consent as Record<string, unknown>).phone
    const authPhone = await getAuth()
      .getUser(uid)
      .then((u) => u.phoneNumber ?? null)
      .catch(() => null)
    if (typeof consentPhone === 'string' && authPhone && consentPhone !== authPhone) {
      logger.info('Skipped — sign-in number changed since consent', { preference })
      return null
    }
    const phone = typeof consentPhone === 'string' ? consentPhone : authPhone
    return phone ? ({ uid, phone, user } as SmsTarget) : null
  } catch (err) {
    logger.error('smsTarget failed', { message: err instanceof Error ? err.message : String(err) })
    return null
  }
}

// Account-level texts (billing, founder, moderation, account notices): either
// mode's master switch will do. Returns whether one was sent.
export async function textAccount(uid: string, preference: 'billing' | 'founder' | 'account', body: string): Promise<boolean> {
  const target = (await smsTarget(uid, preference, 'spark')) ?? (await smsTarget(uid, preference, 'play'))
  return target ? sendSMS(target, body) : false
}

const SPARK_SMS_COOLDOWN_MS = 4 * 60 * 60 * 1000

// At most one Spark text per user every 4 hours. Claims the slot
// (userInternal/{uid}.lastSparkSmsAt) in a transaction so a burst of likes sends one.
export async function claimSparkSmsSlot(uid: string): Promise<boolean> {
  const ref = internalRef(uid)
  try {
    return await getFirestore().runTransaction(async (tx) => {
      const last: unknown = (await tx.get(ref)).data()?.lastSparkSmsAt
      const lastMs = last instanceof Timestamp ? last.toMillis() : typeof last === 'number' ? last : null
      if (lastMs !== null && Date.now() - lastMs < SPARK_SMS_COOLDOWN_MS) return false
      tx.set(ref, { lastSparkSmsAt: FieldValue.serverTimestamp() }, { merge: true })
      return true
    })
  } catch (err) {
    logger.error('claimSparkSmsSlot failed', { message: err instanceof Error ? err.message : String(err) })
    return false
  }
}

// F-089: message texts per recipient, across all their matches — at most one
// every 30 minutes and 10 a day (on top of the 5-minute per-match throttle).
// State lives in userInternal/{uid}.messageSms = { lastAt, windowStart, count },
// all in milliseconds; the day is a 24-hour window from its first text.
export const MESSAGE_SMS_RECIPIENT_GAP_MS = 30 * 60 * 1000
export const MESSAGE_SMS_RECIPIENT_DAILY = 10
const DAY_MS = 24 * 60 * 60 * 1000

export interface MessageSmsState {
  lastAt: number
  windowStart: number
  count: number
}

// Whether another message text may go to this recipient now, and the state to
// store if it does. Malformed state counts as none.
export function decideMessageSms(state: unknown, now: number): { send: boolean; next: MessageSmsState | null } {
  const s = typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const lastAt = num(s.lastAt)
  const windowStart = num(s.windowStart)
  const count = num(s.count) ?? 0
  if (lastAt !== null && now - lastAt < MESSAGE_SMS_RECIPIENT_GAP_MS) return { send: false, next: null }
  if (windowStart === null || now - windowStart >= DAY_MS || now < windowStart) {
    return { send: true, next: { lastAt: now, windowStart: now, count: 1 } }
  }
  if (count >= MESSAGE_SMS_RECIPIENT_DAILY) return { send: false, next: null }
  return { send: true, next: { lastAt: now, windowStart, count: count + 1 } }
}

// Display name for texts: the match's participant snapshot, then the user
// doc. A Play match always uses the Play name — its snapshot may be an older
// one holding the Spark name.
export async function nameFor(
  uid: string,
  snapshots?: Record<string, { displayName?: unknown }>,
  mode?: unknown,
): Promise<string> {
  if (mode === 'play' || mode === 'entanglement') return loadPlayName(uid)
  const fromSnapshot = snapshots?.[uid]?.displayName
  if (typeof fromSnapshot === 'string' && fromSnapshot.trim()) return fromSnapshot.trim()
  const snap = await getFirestore().doc(`users/${uid}`).get().catch(() => null)
  const name: unknown = snap?.data()?.displayName
  return typeof name === 'string' && name.trim() ? name.trim() : 'Someone'
}
