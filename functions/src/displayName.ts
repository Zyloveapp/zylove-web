import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { updateSearchName } from './searchName'
import { requireActive } from './userData'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'

// Changing a public name after it's first set goes through here: the
// Firestore rules stop clients changing users/{uid}.displayName or
// playProfile/data.playDisplayName once set (and stop them touching the
// timestamps), so the 30-day limit can't be skipped by writing directly.
// Spark's name lives on the root doc (mirrored to sparkProfile/data); Play's
// on the Play profile (Stage 2 — no Play data on the public doc).

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

function latest(...times: (number | null)[]): number | null {
  const known = times.filter((t): t is number => t !== null)
  return known.length ? Math.max(...known) : null
}

export const updateDisplayName = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    await requireActive(request.auth.uid) // F-097: not while suspended
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
    const internalRef = db.doc(`userInternal/${request.auth.uid}`)
    await db.runTransaction(async (tx) => {
      const [userSnap, mirrorSnap, internalSnap] = await Promise.all([tx.get(userRef), tx.get(mirrorRef), tx.get(internalRef)])
      const user = userSnap.data()
      if (!user) throw new HttpsError('failed-precondition', 'Profile not found')
      // Play: the Play profile's copies, else (not migrated yet) the root's.
      const src = mode === 'play' ? { ...user, ...Object.fromEntries(Object.entries(mirrorSnap.data() ?? {}).filter(([k]) => k === fields.name || k === fields.updatedAt)) } : user
      if (src[fields.name] === name) return
      // F-079: Play's last change is also kept server-side (playNameLock), so
      // deleting and re-creating the Play profile doesn't reset the limit.
      const last = latest(millis(src[fields.updatedAt]), mode === 'play' ? millis(internalSnap.data()?.playNameLock?.at) : null)
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
      if (mode === 'play') {
        if (!mirrorSnap.exists) throw new HttpsError('failed-precondition', 'No Play profile')
        tx.update(mirrorRef, { playDisplayName: name, playDisplayNameUpdatedAt: FieldValue.serverTimestamp() })
        tx.set(internalRef, { playNameLock: { name, at: FieldValue.serverTimestamp() } }, { merge: true })
        if (user.playDisplayName !== undefined || user.playDisplayNameUpdatedAt !== undefined) {
          tx.update(userRef, { playDisplayName: FieldValue.delete(), playDisplayNameUpdatedAt: FieldValue.delete() })
        }
        return
      }
      tx.update(userRef, { [fields.name]: name, [fields.updatedAt]: FieldValue.serverTimestamp() })
      // Keep the profile subdoc's copy in step (views read the root first).
      // Never create it: a sparkProfile doc would end a Play-only account.
      if (mirrorSnap.exists) tx.update(mirrorRef, { [fields.name]: name })
    })
    // T&S Phase 1: the admin directory searches the Spark display name.
    if (mode === 'spark') await updateSearchName(request.auth.uid, name)
    return { success: true }
  },
)

// F-079: deleting the Play profile (Settings → Delete Play profile) is
// server-side, so the name lock outlives it: the rules let a client delete
// playProfile/data no more. The doc goes (as the app used to delete it — Play
// matches, the Play ID and the rest of Play stay), and userInternal/{uid}.
// playNameLock keeps the name and its last change. A Play name never changed
// is locked from now: re-creating the profile under the same name is always
// allowed (rules), a different one 30 days after the lock — so delete and
// re-create can't stand in for a name change.
export const deletePlayProfile = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const db = getFirestore()
    const userRef = db.doc(`users/${request.auth.uid}`)
    const playRef = userRef.collection('playProfile').doc('data')
    const internalRef = db.doc(`userInternal/${request.auth.uid}`)
    await db.runTransaction(async (tx) => {
      const [userSnap, playSnap, internalSnap] = await Promise.all([tx.get(userRef), tx.get(playRef), tx.get(internalRef)])
      if (!playSnap.exists) return
      const play = playSnap.data() ?? {}
      const user = userSnap.data() ?? {}
      const name = [play.playDisplayName, user.playDisplayName].find((n): n is string => typeof n === 'string' && n.trim() !== '')
      if (name) {
        const at = latest(millis(play.playDisplayNameUpdatedAt), millis(user.playDisplayNameUpdatedAt), millis(internalSnap.data()?.playNameLock?.at))
        tx.set(internalRef, { playNameLock: { name, at: at === null ? Timestamp.now() : Timestamp.fromMillis(at) } }, { merge: true })
      }
      tx.delete(playRef)
    })
    return { success: true }
  },
)
