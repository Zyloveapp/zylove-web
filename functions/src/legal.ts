import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

// Terms acceptance, recorded server-side (F-024). Onboarding's Terms step
// calls recordTermsAcceptance; the server stamps the time, the request's IP
// and user agent, and the versions of the documents in force. Clients can
// read their own records but never write them (firestore.rules).
//
//   users/{uid}/legalAcceptance/main          the latest acceptance
//   users/{uid}/legalAcceptance/{timestamp}   one per acceptance (history)
//
// Both go with the account in onNightlyPurge.

// The "Last updated" dates of src/pages/public/content/{terms,privacy}.html,
// with a .N suffix for a second update on the same day.
// Bump these whenever either document changes, together with the client
// mirror (src/config/legal.ts), which shows existing users the change notice.
export const LEGAL_VERSIONS = { terms: '2026-10-07.2', privacy: '2026-10-07.4' } as const

// Mirrors CONSENT_IDS in src/services/onboarding.ts: every box on the Terms
// step must be ticked.
export const REQUIRED_CONSENTS = ['age', 'terms', 'privacy', 'matching', 'conduct', 'safety'] as const

// The caller's address: the first X-Forwarded-For hop (Cloud Run's proxy
// sets it), else the connection's own.
export function clientIp(
  raw: { headers: Record<string, string | string[] | undefined>; ip?: string; socket?: { remoteAddress?: string } } | undefined,
): string | null {
  const fwd = raw?.headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
  return (first || raw?.ip || raw?.socket?.remoteAddress || null)?.slice(0, 64) ?? null
}

export const recordTermsAcceptance = onCall(
  { timeoutSeconds: 20, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ ok: true; versions: typeof LEGAL_VERSIONS }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const raw = (request.data as Record<string, unknown> | null)?.consents
    const consents = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : []
    const missing = REQUIRED_CONSENTS.filter((c) => !consents.includes(c))
    if (missing.length) throw new HttpsError('invalid-argument', `Missing consents: ${missing.join(', ')}`)

    const ua = request.rawRequest?.headers['user-agent']
    const record = {
      uid,
      mode: 'main',
      acceptedAt: FieldValue.serverTimestamp(),
      consentsAccepted: [...REQUIRED_CONSENTS],
      termsVersion: LEGAL_VERSIONS.terms,
      privacyVersion: LEGAL_VERSIONS.privacy,
      ip: clientIp(request.rawRequest as never),
      userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null,
      source: 'web',
    }
    const col = getFirestore().collection(`users/${uid}/legalAcceptance`)
    const batch = getFirestore().batch()
    batch.set(col.doc('main'), record)
    batch.set(col.doc(String(Date.now())), record)
    await batch.commit()
    logger.info('recordTermsAcceptance', { versions: LEGAL_VERSIONS })
    return { ok: true, versions: LEGAL_VERSIONS }
  },
)

// ─── acknowledgeLegalUpdate ──────────────────────────────────────────────────

// Existing users see an in-app notice when Terms or Privacy change after they
// accepted (Privacy §11, Terms §15). "Got it" records that they were shown
// the current versions — not a new acceptance:
//
//   users/{uid}/legalAcceptance/notice              the latest one shown
//   users/{uid}/legalAcceptance/notice-{timestamp}  history
export const acknowledgeLegalUpdate = onCall(
  { timeoutSeconds: 20, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ ok: true; versions: typeof LEGAL_VERSIONS }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const ua = request.rawRequest?.headers['user-agent']
    const record = {
      uid,
      seenAt: FieldValue.serverTimestamp(),
      termsVersion: LEGAL_VERSIONS.terms,
      privacyVersion: LEGAL_VERSIONS.privacy,
      ip: clientIp(request.rawRequest as never),
      userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null,
      source: 'web',
    }
    const col = getFirestore().collection(`users/${uid}/legalAcceptance`)
    const batch = getFirestore().batch()
    batch.set(col.doc('notice'), record)
    batch.set(col.doc(`notice-${Date.now()}`), record)
    await batch.commit()
    return { ok: true, versions: LEGAL_VERSIONS }
  },
)
