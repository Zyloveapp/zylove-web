import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { parseKeys } from './frankingCore'

// T&S Phase 4 — the evidence locker's encryption and retention, pure.
// Items are sealed with AES-256-GCM under EVIDENCE_LOCKER_KEY (same versioned
// format as the franking key). Retention (Matthew's decisions):
//   • evidence: 30 days after the decision — or the appeal's outcome;
//   • child-safety / NCMEC cases: 1 year after the decision;
//   • a legal hold (incl. law-enforcement preservation) keeps it until released;
//   • never decided: UNDECIDED_MS after it was filed (a backstop, not a policy);
//   • the outcome record (no content): 2 years.

export const DAY_MS = 24 * 60 * 60 * 1000
export const EVIDENCE_AFTER_DECISION_MS = 30 * DAY_MS
export const NCMEC_PRESERVE_MS = 365 * DAY_MS
export const UNDECIDED_MS = 180 * DAY_MS
export const OUTCOME_RETENTION_MS = 2 * 365 * DAY_MS

export interface Sealed {
  v: string
  iv: string
  tag: string
  data: string
}

export function seal(keys: ReturnType<typeof parseKeys>, value: unknown): Sealed {
  const { v, key } = keys[0]
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return { v, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export function open<T>(keys: ReturnType<typeof parseKeys>, s: Sealed): T {
  const k = keys.find((x) => x.v === s.v)
  if (!k) throw new Error(`no locker key ${s.v}`)
  // Low (Semgrep): a full 16-byte tag only — a shorter one would be easier to forge.
  const d = createDecipheriv('aes-256-gcm', Buffer.from(k.key, 'hex'), Buffer.from(s.iv, 'base64'), { authTagLength: 16 })
  d.setAuthTag(Buffer.from(s.tag, 'base64'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8')) as T
}

// When an item may be deleted (null: not yet — under appeal or on hold is
// handled by the caller, which never deletes held items).
export function expiryFor(item: { createdAt: number; decidedAt: number | null; ncmec: boolean; appealPending: boolean }): number | null {
  if (item.appealPending) return null
  if (item.decidedAt === null) return item.createdAt + UNDECIDED_MS
  return item.decidedAt + (item.ncmec ? NCMEC_PRESERVE_MS : EVIDENCE_AFTER_DECISION_MS)
}

export function deletable(item: { expiresAt: number | null; legalHold: unknown }, now = Date.now()): boolean {
  return !item.legalHold && item.expiresAt !== null && item.expiresAt <= now
}
