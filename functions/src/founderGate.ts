import { createHash } from 'node:crypto'
import { Timestamp, type DocumentData } from 'firebase-admin/firestore'
import { BLOCKED_LINE_TYPES } from './signupGuard'

// Who may claim a founder spot themselves (assignFounderBadge), pure. The
// admin dashboard's "Make founder" skips these.
//
// F-114 (M3): a brand-new account can't claim straight away — location is
//   self-reported and a claim gives Elite, so a claim needs an account at
//   least FOUNDER_MIN_AGE_MS old.
// F-115 (M4): the sign-in number must be a mobile line (Twilio Lookup;
//   unknown lets it through) — VoIP numbers made spots cheap to farm.
// F-116 (M5): one founder spot per phone number, ever: a spot that was
//   revoked (inactive, or the account deleted) isn't claimed again, by the
//   same account or a new one on the same number (founderHistory/{phoneHash},
//   server-only).

export const FOUNDER_MIN_AGE_MS = 24 * 60 * 60 * 1000

export type GateRefusal = 'too_new' | 'not_mobile' | 'not_available'

export function founderGate(input: {
  accountCreatedAt: unknown
  lineType: string | null
  recordStatus: unknown
  history: DocumentData | undefined
  uid: string
  now?: number
}): GateRefusal | null {
  const now = input.now ?? Date.now()
  if (input.recordStatus === 'revoked') return 'not_available'
  const h = input.history
  if (h && (h.status === 'revoked' || (h.status === 'active' && h.uid !== input.uid) || h.status === 'converted')) return 'not_available'
  const created = typeof input.accountCreatedAt === 'number' ? input.accountCreatedAt : null
  if (created === null || now - created < FOUNDER_MIN_AGE_MS) return 'too_new'
  if (input.lineType !== null && BLOCKED_LINE_TYPES.has(input.lineType)) return 'not_mobile'
  return null
}

export const founderPhoneHash = (phone: string): string => createHash('sha256').update(phone.trim()).digest('hex')

// F-116: what a revoked founder's plan becomes (not paying, no Elite by
// identity). It used to be a brand-new 30-day trial every time.
//   - a trial already on the account: kept as it was;
//   - a paid plan on record for the number: Free, never a trial;
//   - a trial on record for the number (trialHistory): that one;
//   - otherwise a new trial if the city is open, pre-launch if not.
export type RevokedPlan =
  | { kind: 'keep' }
  | { kind: 'paid' }
  | { kind: 'prior'; trialStartedAt: Timestamp; trialEndsAt: Timestamp }
  | { kind: 'new' }
  | { kind: 'prelaunch' }

export function revokedPlan(input: { internal: DocumentData | undefined; prior: DocumentData | null; cityOpen: boolean }): RevokedPlan {
  if (input.internal?.trialStartedAt != null) return { kind: 'keep' }
  if (input.internal?.hadPaidPlan === true || input.prior?.hadPaidPlan === true) return { kind: 'paid' }
  const p = input.prior
  if (p?.trialStartedAt instanceof Timestamp && p.trialEndsAt instanceof Timestamp) {
    return { kind: 'prior', trialStartedAt: p.trialStartedAt, trialEndsAt: p.trialEndsAt }
  }
  return input.cityOpen ? { kind: 'new' } : { kind: 'prelaunch' }
}
