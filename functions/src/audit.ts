import { HttpsError } from 'firebase-functions/v2/https'
import { getAuth } from 'firebase-admin/auth'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { isAdminAuth } from './userData'
import { takeRateLimit } from './rateLimits'

// T&S Phase 1: one audit log for everything admins see, download and do.
//   adminAudit/{auto} (server-only): { actor, action, target, reason,
//   detail, at, expiresAt }
// `action` is "<area>.<verb>" (reports.list, user.suspend, photo.view…).
// `detail` is a small summary (filters, counts, durations) — never message
// content, photos or personal data beyond account ids. Kept AUDIT_RETENTION,
// then deleted by purgeAdminAudit.

export const AUDIT_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000

export interface AuditEntry {
  actor: string
  action: string
  target?: string | null
  reason?: string | null
  detail?: Record<string, unknown>
}

export async function audit(e: AuditEntry): Promise<void> {
  await getFirestore()
    .collection('adminAudit')
    .add({
      actor: e.actor,
      action: e.action,
      target: e.target ?? null,
      reason: e.reason ?? null,
      detail: e.detail ?? {},
      at: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + AUDIT_RETENTION_MS),
    })
}

// F-094: a signed-in non-admin calling an admin callable is logged too —
// admin.denied, with only the caller's uid and which call — at most
// DENIED_LOGS a day per caller, so the log can't be flooded.
const DENIED_LOGS = { max: 5, windowMs: 24 * 60 * 60 * 1000 }
async function auditDenied(uid: string, call: string): Promise<void> {
  const logged = await takeRateLimit(uid, 'adminDenied', DENIED_LOGS).then(() => true, () => false)
  if (logged) await audit({ actor: uid, action: 'admin.denied', detail: { call } }).catch(() => {})
}

// Admins only (the `admin` auth claim); `call` names the callable for the
// denied log. F-097: a claim taken away keeps working until that admin's ID
// token refreshes (up to an hour). Nothing in the functions removes the
// claim today; whatever does should also call auth.revokeRefreshTokens(uid).
export async function requireAdmin(auth: { uid: string; token?: Record<string, unknown> } | undefined, call: string): Promise<string> {
  if (!auth) throw new HttpsError('unauthenticated', 'Login required')
  if (!isAdminAuth(auth)) {
    await auditDenied(auth.uid, call)
    throw new HttpsError('permission-denied', 'Admins only.')
  }
  return auth.uid
}

// Low (fresh-eyes review): for destructive admin actions, the claim as it
// is now on the Auth record, not the one in the caller's ID token — a
// removed claim lives on in a token for up to an hour.
export async function requireLiveAdmin(uid: string): Promise<void> {
  const user = await getAuth().getUser(uid).catch(() => null)
  if (user?.customClaims?.admin !== true) throw new HttpsError('permission-denied', 'Admins only.')
}

// Admins only — and every admin call is logged before it returns anything.
export async function requireAdminAudited(
  auth: { uid: string; token?: Record<string, unknown> } | undefined,
  entry: Omit<AuditEntry, 'actor'>,
): Promise<string> {
  const uid = await requireAdmin(auth, entry.action)
  await audit({ ...entry, actor: uid })
  return uid
}

export const purgeAdminAudit = onSchedule(
  { schedule: '45 2 * * *', timeZone: 'America/Chicago', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db = getFirestore()
    let deleted = 0
    for (;;) {
      const due = await db.collection('adminAudit').where('expiresAt', '<=', Timestamp.now()).limit(400).get()
      if (due.empty) break
      const batch = db.batch()
      due.docs.forEach((d) => batch.delete(d.ref))
      await batch.commit()
      deleted += due.size
    }
    logger.info('purgeAdminAudit', { deleted })
  },
)
