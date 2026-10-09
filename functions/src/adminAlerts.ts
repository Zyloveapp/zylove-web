// Admin notifications: texts to admins about what needs them (photos to
// review, reports, trust flags, appeals, new accounts…). The rules —
// toggles, batching, the daily cap, quiet hours and every text — are in
// adminAlertsCore.ts.
//
//   adminAlertQueue/{auto}                one event, written by queueAdminAlert
//                                         from wherever it happens; processed
//                                         (and deleted) by adminAlertOnQueue
//   adminNotificationSettings/{adminUid}  the admin's toggles, quiet hours,
//                                         excluded test accounts and SMS opt-in.
//                                         The admin reads their own (rules);
//                                         writes only via adminSetNotificationSettings
//                                         (validated, audited)
//   adminNotificationState/{adminUid}     batching counts and the day's tally
//                                         (server-only)
//
// Callers only write a queue doc, so they need no Twilio secrets and an
// alert can never break the flow that raised it. Only adminAlertOnQueue and
// flushAdminAlerts send.

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import * as functionsV1 from 'firebase-functions/v1'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import {
  type AdminEvent,
  type Detail,
  type QueuedEvent,
  ADMIN_SMS_CONFIRMATION,
  CENTRAL,
  EVENTS,
  applyPatch,
  flush,
  normalizeSettings,
  normalizeState,
  onEvent,
  parsePatch,
  smsEventFor,
} from './adminAlertsCore'
import { SMS_FROM_SECRETS, SMS_SECRETS, adminSmsStatus, smsFromNumber, textAdmin } from './sms'
import { adminUids, internalRef } from './userData'
import { audit, requireAdmin, requireAdminAudited } from './audit'

const DAY_MS = 24 * 60 * 60 * 1000
// Queue docs are deleted once processed; a stuck one goes after a week.
const QUEUE_TTL_MS = 7 * DAY_MS
const EXPIRY_WARNING_MS = 7 * DAY_MS

function db() {
  return getFirestore()
}

export const settingsDoc = (uid: string) => db().doc(`adminNotificationSettings/${uid}`)
const stateDoc = (uid: string) => db().doc(`adminNotificationState/${uid}`)

// Curated profiles and seeds by uid; an isBot account or an admin's own
// account by their docs.
const BOT_UID = /^(zbot|seed)-/

async function excludedSubject(uid: string): Promise<boolean> {
  if (BOT_UID.test(uid)) return true
  const [user, internal] = await Promise.all([db().doc(`users/${uid}`).get(), internalRef(uid).get()])
  return user.data()?.isBot === true || internal.data()?.admin === true
}

// ─── Raising an alert ────────────────────────────────────────────────────────

export interface AlertInput {
  // The account the event is about (excluded when it's a test, curated or
  // admin account). None for events about no one in particular.
  subjectUid?: string | null
  n?: number
  detail?: Detail
  // Trust flags: the flag's reason keys.
  reasons?: string[]
  // F-070: who a report is about (subjectUid is the reporter) — urgent texts
  // count once per person per hour, and an excluded account is excluded
  // either way.
  aboutUid?: string | null
}

// Never throws: an alert must not break what raised it.
export async function queueAdminAlert(type: AdminEvent, input: AlertInput = {}): Promise<void> {
  try {
    if (input.subjectUid && BOT_UID.test(input.subjectUid)) return
    await db()
      .collection('adminAlertQueue')
      .add({
        type,
        n: input.n ?? 1,
        detail: input.detail ?? {},
        reasons: input.reasons ?? [],
        subjectUid: input.subjectUid ?? null,
        aboutUid: input.aboutUid ?? null,
        at: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + QUEUE_TTL_MS),
      })
  } catch (err) {
    logger.error('queueAdminAlert failed', { type, message: err instanceof Error ? err.message : String(err) })
  }
}

// ─── Sending ─────────────────────────────────────────────────────────────────

async function sendAll(adminUid: string, texts: string[]): Promise<void> {
  for (const body of texts) {
    const result = await textAdmin(adminUid, body)
    if (result !== 'sent') logger.warn('Admin alert not sent', { result })
  }
}

// One event for one admin: their settings decide whether it counts, the
// state transaction decides whether it's texted now or batched.
async function deliverTo(adminUid: string, ev: QueuedEvent, subjectUid: string | null, now: number): Promise<void> {
  const settings = normalizeSettings((await settingsDoc(adminUid).get()).data())
  if (subjectUid && settings.excludedUids.includes(subjectUid)) return
  if (ev.about && settings.excludedUids.includes(ev.about)) return
  const allowed = smsEventFor(settings, ev)
  if (!allowed) return
  const texts = await db().runTransaction(async (tx) => {
    const state = normalizeState((await tx.get(stateDoc(adminUid))).data())
    const out = onEvent(state, settings, ev.type, allowed.n, allowed.detail, now, ev.about)
    tx.set(stateDoc(adminUid), { ...out.state, updatedAt: FieldValue.serverTimestamp() })
    return out.texts
  })
  await sendAll(adminUid, texts)
}

export const adminAlertOnQueue = onDocumentCreated(
  { document: 'adminAlertQueue/{id}', memory: '256MiB', secrets: SMS_SECRETS },
  async (event) => {
    const data = event.data?.data()
    if (!data) return
    try {
      const type = data.type as AdminEvent
      if (!(type in EVENTS)) return void logger.warn('Unknown admin alert', { type })
      const subjectUid = typeof data.subjectUid === 'string' ? data.subjectUid : null
      if (subjectUid && (await excludedSubject(subjectUid))) return
      const ev: QueuedEvent = {
        type,
        n: typeof data.n === 'number' && data.n > 0 ? Math.floor(data.n) : 1,
        detail: (data.detail ?? {}) as Detail,
        reasons: Array.isArray(data.reasons) ? (data.reasons as unknown[]).filter((r): r is string => typeof r === 'string') : [],
        ...(typeof data.aboutUid === 'string' && data.aboutUid ? { about: data.aboutUid } : {}),
      }
      const now = Date.now()
      for (const uid of await adminUids()) {
        await deliverTo(uid, ev, subjectUid, now).catch((err) =>
          logger.error('Admin alert failed', { type, message: err instanceof Error ? err.message : String(err) }),
        )
      }
    } finally {
      await event.data?.ref.delete().catch(() => {})
    }
  },
)

// Batched counts, collapsed urgent ones and the end-of-quiet-hours / 8 AM
// summaries.
export const flushAdminAlerts = onSchedule(
  { schedule: 'every 5 minutes', timeZone: CENTRAL, memory: '256MiB', secrets: SMS_SECRETS },
  async () => {
    const now = Date.now()
    for (const uid of await adminUids()) {
      try {
        const settings = normalizeSettings((await settingsDoc(uid).get()).data())
        const texts = await db().runTransaction(async (tx) => {
          const snap = await tx.get(stateDoc(uid))
          if (!snap.exists) return []
          const out = flush(normalizeState(snap.data()), settings, now)
          tx.set(stateDoc(uid), { ...out.state, updatedAt: FieldValue.serverTimestamp() })
          return out.texts
        })
        // Opted out of admin texts since they were counted: drop them.
        if (settings.smsConsent && settings.sms.all) await sendAll(uid, texts)
      } catch (err) {
        logger.error('flushAdminAlerts failed', { message: err instanceof Error ? err.message : String(err) })
      }
    }
  },
)

// ─── Events with no other home ───────────────────────────────────────────────

// A new account, once the phone is verified: phone sign-in only creates the
// Auth user after the code is confirmed, so abandoned code requests never
// count. Accounts with no phone (admin-made test accounts) don't either.
export const adminAlertOnAccountCreated = functionsV1
  .runWith({ memory: '256MB' })
  .auth.user()
  .onCreate(async (user) => {
    if (!user.phoneNumber) return
    await queueAdminAlert('newAccount', { subjectUid: user.uid })
  })

// Once per account and mode, ever: userInternal.adminAlerted.{spark,play}.
// Never for an account being deleted: deletion marks the root doc before it
// clears userInternal, so reading the root here keeps the marker from
// re-creating userInternal after it was cleared.
async function profileCompleted(uid: string, mode: 'spark' | 'play'): Promise<void> {
  if (BOT_UID.test(uid)) return
  const first = await db().runTransaction(async (tx) => {
    const ref = internalRef(uid)
    const [root, internal] = await Promise.all([tx.get(db().doc(`users/${uid}`)), tx.get(ref)])
    if (!root.exists || root.data()?.isDeleted === true) return false
    const done = internal.data()?.adminAlerted?.[mode] === true
    if (!done) tx.set(ref, { adminAlerted: { [mode]: true } }, { merge: true })
    return !done
  })
  if (first) await queueAdminAlert('profileCompleted', { subjectUid: uid, detail: { [mode]: 1 } })
}

const turnedOn = (before: DocumentData | undefined, after: DocumentData | undefined, key: string) =>
  after?.[key] === true && before?.[key] !== true

// Spark onboarding sets onboardingComplete on the root doc. Play-only
// onboarding sets it too, in the same batch as playOnboardingComplete — that
// one counts as Play (below), not Spark.
export const adminAlertOnProfile = onDocumentWritten({ document: 'users/{uid}', memory: '256MiB' }, async (event) => {
  if (!turnedOn(event.data?.before.data(), event.data?.after.data(), 'onboardingComplete')) return
  const uid = event.params.uid
  const play = (await db().doc(`users/${uid}/playProfile/data`).get()).data()
  if (play?.playOnboardingComplete === true) return
  await profileCompleted(uid, 'spark')
})

export const adminAlertOnPlayProfile = onDocumentWritten({ document: 'users/{uid}/playProfile/data', memory: '256MiB' }, async (event) => {
  if (!turnedOn(event.data?.before.data(), event.data?.after.data(), 'playOnboardingComplete')) return
  await profileCompleted(event.params.uid, 'play')
})

// Evidence nobody has decided is deleted UNDECIDED_MS after it was filed.
// A week before, one urgent text (each item warned once).
export const warnExpiringEvidence = onSchedule(
  { schedule: '0 9 * * *', timeZone: CENTRAL, memory: '256MiB', timeoutSeconds: 120 },
  async () => {
    const now = Date.now()
    const snap = await db()
      .collection('evidenceLocker')
      .where('expiresAt', '<=', Timestamp.fromMillis(now + EXPIRY_WARNING_MS))
      .get()
    const due = snap.docs.filter((d) => {
      const x = d.data()
      const at = x.expiresAt instanceof Timestamp ? x.expiresAt.toMillis() : 0
      return x.status === 'open' && x.decidedAt == null && !x.legalHold && x.appealPending !== true && at > now && x.expiryWarnedAt == null
    })
    if (due.length === 0) return
    const batch = db().batch()
    for (const d of due) batch.update(d.ref, { expiryWarnedAt: FieldValue.serverTimestamp() })
    await batch.commit()
    await queueAdminAlert('evidenceExpiring', { n: due.length })
    logger.info('warnExpiringEvidence', { items: due.length })
  },
)

// ─── The settings screen ─────────────────────────────────────────────────────

// Saves a change; every change is in the audit log (which toggles, times and
// counts changed — nothing else). Opting in sends the confirmation text.
export const adminSetNotificationSettings = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public', secrets: SMS_SECRETS },
  async (request) => {
    const uid = await requireAdmin(request.auth, 'adminSetNotificationSettings')
    let patch
    try {
      patch = parsePatch(request.data)
    } catch (err) {
      throw new HttpsError('invalid-argument', err instanceof Error ? err.message : 'Bad settings')
    }
    const now = Date.now()
    const { next, changed } = await db().runTransaction(async (tx) => {
      const current = normalizeSettings((await tx.get(settingsDoc(uid))).data())
      let out
      try {
        out = applyPatch(current, patch, now)
      } catch (err) {
        throw new HttpsError('invalid-argument', err instanceof Error ? err.message : 'Bad settings')
      }
      if (Object.keys(out.changed).length > 0) tx.set(settingsDoc(uid), { ...out.next, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid })
      return out
    })
    if (Object.keys(changed).length === 0) return { ok: true, settings: next, confirmation: null }
    await audit({ actor: uid, action: 'adminNotify.settings_update', target: uid, detail: { changed } })
    const optedIn = changed.smsConsent?.[1] === true
    const confirmation = optedIn ? await textAdmin(uid, ADMIN_SMS_CONFIRMATION) : null
    return { ok: true, settings: next, confirmation }
  },
)

// Where texts go (last 4 digits only), whether that number replied STOP and
// the number to text START to.
// Sends nothing, so it binds only the sending number (F-093).
export const adminNotificationStatus = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public', secrets: SMS_FROM_SECRETS },
  async (request) => {
    const uid = await requireAdminAudited(request.auth, { action: 'adminNotify.status', target: null })
    const { phone, optedOut } = await adminSmsStatus(uid)
    return { phoneLast4: phone ? phone.slice(-4) : null, optedOut, startNumber: smsFromNumber() }
  },
)
