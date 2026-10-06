// SMS notifications via Twilio's REST API. Nothing here throws: a failed or
// skipped text must never break the flow that triggered it.

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

// 'billing' (a failed payment) and 'founder' (founder spot at risk / open)
// have no toggle of their own: on with the master switch.
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

// Sends one text. Returns whether Twilio accepted it.
export async function sendSMS(to: string, body: string): Promise<boolean> {
  try {
    const sid = twilioAccountSid.value()
    const token = twilioAuthToken.value()
    const from = twilioFromNumber.value()
    if (!sid || !token || !from) {
      logger.warn('sendSMS: Twilio secrets not configured, skipping')
      return false
    }
    if (!E164.test(to)) {
      logger.warn('sendSMS: recipient is not an E.164 number, skipping')
      return false
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
      logger.error('sendSMS: Twilio rejected the message', { status: response.status, detail: detail.slice(0, 300) })
      return false
    }
    logger.info('sendSMS: sent')
    return true
  } catch (err) {
    logger.error('sendSMS failed', { message: err instanceof Error ? err.message : String(err) })
    return false
  }
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

export interface SmsTarget {
  uid: string
  phone: string
  user: DocumentData
}

// The user's phone number if they've turned SMS on and this kind of text is
// enabled, else null. The number comes from Firebase Auth (phone sign-in),
// falling back to the one recorded at consent (private/account). Preferences
// live in private/settings (userData.ts).
export async function smsTarget(uid: string, preference: SmsPreference, mode: SmsMode = 'spark'): Promise<SmsTarget | null> {
  try {
    const user = (await userRef(uid).get()).data()
    if (!user) return null
    const settings = await loadSettings(uid, user)
    if (!smsEnabledFor(settings.smsNotificationsEnabled, mode) || !smsPreferenceOn(settings.smsNotifications, preference, mode)) {
      return null
    }
    if (inQuietHours(settings.smsQuietHours)) {
      logger.info('Skipped — quiet hours', { preference, mode })
      return null
    }
    const authPhone = await getAuth()
      .getUser(uid)
      .then((u) => u.phoneNumber ?? null)
      .catch(() => null)
    const consentPhone: unknown = (await loadAccount(uid, user)).smsConsent?.phone
    const phone = authPhone ?? (typeof consentPhone === 'string' ? consentPhone : null)
    return phone ? { uid, phone, user } : null
  } catch (err) {
    logger.error('smsTarget failed', { message: err instanceof Error ? err.message : String(err) })
    return null
  }
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
