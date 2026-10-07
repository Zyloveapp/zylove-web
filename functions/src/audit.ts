import { HttpsError } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { isAdminAuth } from './userData'

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

// Admins only — and every admin call is logged before it returns anything.
export async function requireAdminAudited(
  auth: { uid: string; token?: Record<string, unknown> } | undefined,
  entry: Omit<AuditEntry, 'actor'>,
): Promise<string> {
  if (!auth) throw new HttpsError('unauthenticated', 'Login required')
  if (!isAdminAuth(auth)) throw new HttpsError('permission-denied', 'Admins only.')
  await audit({ ...entry, actor: auth.uid })
  return auth.uid
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
