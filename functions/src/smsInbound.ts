// Twilio inbound webhook: texts people send to our number. STOP and START
// keep our records in step with Twilio's own opt-out list; HELP and the
// STOP/START confirmations are Twilio's auto-replies (Messaging Service →
// Opt-Out Management), so this never replies.
//
// Set as the Messaging Service's incoming-message webhook (HTTP POST):
//   https://us-central1-zylove.cloudfunctions.net/twilioInbound

import { createHmac, timingSafeEqual } from 'node:crypto'
import { onRequest } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { TWILIO_AUTH_TOKEN, optOutRef, recordOptOut } from './sms'
import { accountRef, loadAccount, loadSettings, settingsRef } from './userData'

// Twilio's standard keywords. With Advanced Opt-Out on, Twilio also sends
// OptOutType (STOP / START / HELP), which wins.
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE'])
const START_WORDS = new Set(['START', 'UNSTOP', 'YES'])

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

type Kind = 'stop' | 'start' | 'other'

export function kindOf(optOutType: unknown, body: unknown): Kind {
  if (optOutType === 'STOP') return 'stop'
  if (optOutType === 'START') return 'start'
  if (typeof optOutType === 'string' && optOutType) return 'other'
  const word = typeof body === 'string' ? body.trim().toUpperCase().replace(/\s+/g, ' ') : ''
  if (STOP_WORDS.has(word)) return 'stop'
  if (START_WORDS.has(word)) return 'start'
  return 'other'
}

// X-Twilio-Signature: base64 HMAC-SHA1 (auth token) of the full URL Twilio
// called, followed by every POST parameter as name+value, sorted by name.
export function twilioSignature(authToken: string, url: string, params: Record<string, unknown>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + (Array.isArray(params[k]) ? (params[k] as unknown[]).join('') : String(params[k] ?? '')), url)
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64')
}

function sameSignature(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// The URL Twilio signed can reach us as cloudfunctions.net or run.app, and
// the path the function sees varies, so any plausible form is accepted.
function candidateUrls(req: { headers: Record<string, unknown>; originalUrl: string }): string[] {
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''
  const hosts = [req.headers['x-forwarded-host'], req.headers.host].filter((h): h is string => typeof h === 'string' && h !== '')
  const urls = new Set<string>()
  for (const host of hosts) {
    urls.add(`https://${host}${req.originalUrl}`)
    urls.add(`https://${host}/twilioInbound${query}`)
  }
  const project = process.env.GCLOUD_PROJECT
  if (project) urls.add(`https://us-central1-${project}.cloudfunctions.net/twilioInbound${query}`)
  return [...urls]
}

async function uidForPhone(phone: string): Promise<string | null> {
  return getAuth()
    .getUserByPhoneNumber(phone)
    .then((u) => u.uid)
    .catch(() => null)
}

// STOP: the registry blocks every send to the number; the account's texts are
// switched off (remembering how they were, for START) so Settings shows it.
async function handleStop(phone: string, keyword: string): Promise<void> {
  await recordOptOut(phone, 'stop', keyword)
  const uid = await uidForPhone(phone)
  if (!uid) return
  const account = await loadAccount(uid)
  if (account.smsOptOut != null) return
  const settings = await loadSettings(uid)
  const batch = getFirestore().batch()
  batch.set(
    accountRef(uid),
    { smsOptOut: { at: FieldValue.serverTimestamp(), previousEnabled: settings.smsNotificationsEnabled ?? null } },
    { merge: true },
  )
  batch.set(settingsRef(uid), { smsNotificationsEnabled: { spark: false, play: false } }, { merge: true })
  await batch.commit()
}

// START: texts resume as they were before STOP (only with a consent record).
async function handleStart(phone: string): Promise<void> {
  await optOutRef(phone).delete()
  const uid = await uidForPhone(phone)
  if (!uid) return
  const account = await loadAccount(uid)
  const optOut: unknown = account.smsOptOut
  if (optOut == null) return
  const previous = typeof optOut === 'object' ? (optOut as Record<string, unknown>).previousEnabled : null
  const batch = getFirestore().batch()
  batch.set(accountRef(uid), { smsOptOut: FieldValue.delete() }, { merge: true })
  if (account.smsConsent != null && (typeof previous === 'boolean' || (typeof previous === 'object' && previous !== null))) {
    batch.set(settingsRef(uid), { smsNotificationsEnabled: previous }, { merge: true })
  }
  await batch.commit()
}

// F-097: each message is handled once. A captured, correctly signed request
// replayed later (say, an old STOP after the person texted START) is
// ignored: twilioInboundSeen/{MessageSid} (server-only) is written once a
// message has been handled — not before, so Twilio's own retry after a 500
// still goes through — and kept SEEN_KEEP_MS (expiresAt, for a Firestore
// TTL policy). Twilio always sends a MessageSid; a request without one
// can't be checked and is handled as before.
const SEEN_KEEP_MS = 30 * 24 * 60 * 60 * 1000
export const messageSidOf = (params: Record<string, unknown>): string | null =>
  typeof params.MessageSid === 'string' && /^[A-Za-z0-9]{2,64}$/.test(params.MessageSid) ? params.MessageSid : null
const seenRef = (sid: string) => getFirestore().doc(`twilioInboundSeen/${sid}`)

export const twilioInbound = onRequest(
  { timeoutSeconds: 30, memory: '256MiB', secrets: [TWILIO_AUTH_TOKEN], invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed')
      return
    }
    const params = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
    const signature = req.headers['x-twilio-signature']
    const token = TWILIO_AUTH_TOKEN.value()
    const valid =
      typeof signature === 'string' &&
      !!token &&
      candidateUrls(req).some((url) => sameSignature(twilioSignature(token, url, params), signature))
    if (!valid) {
      logger.warn('twilioInbound: bad or missing signature', { candidates: candidateUrls(req) })
      res.status(403).send('Forbidden')
      return
    }

    const from = typeof params.From === 'string' ? params.From : ''
    const kind = kindOf(params.OptOutType, params.Body)
    const sid = messageSidOf(params)
    try {
      if (sid && (await seenRef(sid).get()).exists) {
        logger.warn('twilioInbound: message already handled — ignored', { kind })
        res.type('text/xml').send(EMPTY_TWIML)
        return
      }
      if (/^\+[1-9]\d{6,14}$/.test(from)) {
        if (kind === 'stop') await handleStop(from, typeof params.Body === 'string' ? params.Body.trim().slice(0, 20) : 'STOP')
        else if (kind === 'start') await handleStart(from)
      }
      if (sid) await seenRef(sid).set({ at: FieldValue.serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + SEEN_KEEP_MS) })
      logger.info('twilioInbound', { kind })
    } catch (err) {
      // 500 makes Twilio retry; the registry write is idempotent.
      logger.error('twilioInbound failed', { kind, message: err instanceof Error ? err.message : String(err) })
      res.status(500).send('Error')
      return
    }
    res.type('text/xml').send(EMPTY_TWIML)
  },
)
