import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { buildBioPrompt, parseBioRequest } from './bioPrompt'

initializeApp()

const anthropicKey = defineSecret('ANTHROPIC_API_KEY')

const MODEL = 'claude-sonnet-4-6'
const MAX_BIO_LENGTH = 500

interface BioResponse {
  bio: string
}

function extractText(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('content' in body)) return ''
  const { content } = body as { content: unknown }
  if (!Array.isArray(content)) return ''
  const first: unknown = content[0]
  if (typeof first !== 'object' || first === null || !('text' in first)) return ''
  const { text } = first as { text: unknown }
  return typeof text === 'string' ? text.trim() : ''
}

// Writes a Spark bio from onboarding answers. Never throws: any failure
// returns an empty bio and the client falls back to its local template.
export const generateSparkBio = onCall(
  { timeoutSeconds: 120, memory: '256MiB', secrets: [anthropicKey], invoker: 'public' },
  async (request): Promise<BioResponse> => {
    // invoker is public (org policy), so gate spend on a signed-in caller.
    if (!request.auth) return { bio: '' }

    try {
      const input = parseBioRequest(request.data)
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey.value(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 400,
          messages: [{ role: 'user', content: buildBioPrompt(input) }],
        }),
      })

      if (!response.ok) {
        logger.error('generateSparkBio: Anthropic API error', { status: response.status })
        return { bio: '' }
      }

      const bio = extractText(await response.json())
      return { bio: bio.slice(0, MAX_BIO_LENGTH) }
    } catch (err) {
      logger.error('generateSparkBio failed', { message: err instanceof Error ? err.message : String(err) })
      return { bio: '' }
    }
  },
)

// Trust/safety defaults. Firestore rules reject any client write to these, so
// profiles created by the web onboarding lack them — and Discover queries
// isSuspended == false, which never matches a missing field.
const TRUST_DEFAULTS = {
  isSuspended: false,
  reportCount: 0,
  verificationStatus: 'unverified',
  subscriptionTier: 'free',
  sparkScore: 50,
} as const

// Fills in whichever trust/safety fields are missing on the caller's own
// users/{uid} doc. Only missing fields are written, so values set elsewhere
// (e.g. Elite from a founder code) are never overwritten. Idempotent.
export const initUserDefaults = onCall(
  { timeoutSeconds: 30, memory: '128MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')

    const ref = getFirestore().collection('users').doc(request.auth.uid)
    const snap = await ref.get()
    // Never create a stub profile — onboarding must have saved the doc first.
    if (!snap.exists) throw new HttpsError('failed-precondition', 'Profile not found')

    const data = snap.data() ?? {}
    const missing = Object.fromEntries(
      Object.entries(TRUST_DEFAULTS).filter(([field]) => data[field] === undefined),
    )
    if (Object.keys(missing).length > 0) {
      await ref.set(missing, { merge: true })
      logger.info('initUserDefaults: filled missing trust fields', { fields: Object.keys(missing) })
    }
    return { success: true }
  },
)
