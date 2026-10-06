import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'

// Changing a public name after it's first set goes through here: the
// Firestore rules stop clients changing users/{uid}.displayName or
// .playDisplayName once set (and stop them touching the timestamps), so the
// 30-day limit can't be skipped by writing directly.

const CHANGE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000
// Letters (any language), numbers, and single spaces, hyphens or apostrophes
// between them — O'Brien, Mary-Jane, D’Angelo.
const NAME_PATTERN = /^[\p{L}\p{M}\p{N}]+(?:[ '’-][\p{L}\p{M}\p{N}]+)*$/u

const FIELDS = {
  spark: { name: 'displayName', updatedAt: 'displayNameUpdatedAt', mirror: 'sparkProfile' },
  play: { name: 'playDisplayName', updatedAt: 'playDisplayNameUpdatedAt', mirror: 'playProfile' },
} as const

function millis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis()
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export const updateDisplayName = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const data = (request.data ?? {}) as Record<string, unknown>
    const mode = data.mode
    if (mode !== 'spark' && mode !== 'play') throw new HttpsError('invalid-argument', 'mode must be spark or play')
    const name = typeof data.displayName === 'string' ? data.displayName.trim().replace(/\s+/g, ' ') : ''
    if (name.length < 2 || name.length > 20) {
      throw new HttpsError('invalid-argument', 'Names must be 2–20 characters.')
    }
    if (!NAME_PATTERN.test(name)) {
      throw new HttpsError('invalid-argument', 'Names can use letters, numbers, spaces, hyphens and apostrophes only.')
    }

    const fields = FIELDS[mode]
    const db = getFirestore()
    const userRef = db.doc(`users/${request.auth.uid}`)
    const mirrorRef = userRef.collection(fields.mirror).doc('data')
    await db.runTransaction(async (tx) => {
      const [userSnap, mirrorSnap] = await Promise.all([tx.get(userRef), tx.get(mirrorRef)])
      const user = userSnap.data()
      if (!user) throw new HttpsError('failed-precondition', 'Profile not found')
      if (user[fields.name] === name) return
      const last = millis(user[fields.updatedAt])
      if (last !== null && Date.now() - last < CHANGE_INTERVAL_MS) {
        const next = new Date(last + CHANGE_INTERVAL_MS).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'America/Chicago',
        })
        throw new HttpsError(
          'failed-precondition',
          `Display name can only be changed once every 30 days. Next change available: ${next}`,
        )
      }
      tx.update(userRef, { [fields.name]: name, [fields.updatedAt]: FieldValue.serverTimestamp() })
      // Keep the profile subdoc's copy in step (views read the root first).
      // Never create it: a sparkProfile doc would end a Play-only account.
      if (mirrorSnap.exists) tx.update(mirrorRef, { [fields.name]: name })
    })
    return { success: true }
  },
)
