import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { ensurePlayId, playIdOf } from './playIds'
import { isBotUid } from './playAccess'
import { maskProfileDoc } from './profileText'

// F-062 — the Play profile others see: playProfiles/{playId}, a server-kept
// copy of users/{uid}/playProfile/data (now owner-only) with only what a
// Play profile shows — never the uid, the Spark profile or anything from it
// except the age (Matthew, 2026-10-08: Play cards show the Play profile,
// plus age and distance) — and, while it lasts, the new-account marker
// (newUntil, a safety signal for chats). Also the owner's Play chat key (publicPlayKey),
// published by the app (publishPlayKey) — a separate key from Spark's, so
// the two can't be matched up.
//
// Readable (firestore.rules) by viewers with Play access when the owner has
// it too, isn't suspended, hasn't blocked them and isn't hidden — or is
// matched with them in Play.

const PUBLIC_FIELDS = [
  'photoURLs',
  'playDisplayName',
  'playVisibility',
  'playBio',
  'spiceLevel',
  'playInterestTags',
  'playNonNegotiables',
  'promptAnswers',
  'playPromptAnswers',
  'playHeight',
  'playBodyType',
  'playBodyHair',
  'playGrooming',
  'playEnergy',
  'typePreferences',
  'goDeeper',
  'playOnboardingComplete',
] as const

const db = () => getFirestore()
export const playProfileRef = (playId: string) => db().doc(`playProfiles/${playId}`)

// Only Play photos keyed by Play ID go out (playPhotos/{playId}/…), or a
// plain web address — never anything with the uid in it (an old
// photos/{uid}/play/… path or a download URL to one).
function playPhotos(v: unknown, uid: string, playId: string): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && !x.includes(uid) && (x.startsWith(`playPhotos/${playId}/`) || x.startsWith('https://')))
    : []
}

export function publicPlayProfile(uid: string, playId: string, play: DocumentData, root: DocumentData | undefined): DocumentData {
  const out: DocumentData = {}
  for (const f of PUBLIC_FIELDS) if (play[f] !== undefined) out[f] = play[f]
  out.photoURLs = playPhotos(play.photoURLs, uid, playId)
  // Curated profiles name their Play profile with its own displayName.
  if (isBotUid(uid) && typeof play.displayName === 'string' && !out.playDisplayName) out.playDisplayName = play.displayName
  out.age = typeof root?.age === 'number' && root.age > 0 ? root.age : null
  out.curated = isBotUid(uid)
  // A safety signal, not a profile detail: the chat's new-account note
  // (first 48 hours) shows in Play too.
  out.newUntil = typeof root?.newUntil === 'number' && root.newUntil > Date.now() ? root.newUntil : null
  return out
}

// Rewrites the public copy from the owner's Play profile (or removes it).
export async function refreshPlayProfile(uid: string): Promise<void> {
  const [playSnap, rootSnap] = await Promise.all([db().doc(`users/${uid}/playProfile/data`).get(), db().doc(`users/${uid}`).get()])
  const root = rootSnap.data()
  if (!playSnap.exists || !root || root.isDeleted === true) {
    const playId = await playIdOf(uid)
    if (playId) await playProfileRef(playId).delete()
    return
  }
  const playId = await ensurePlayId(uid)
  const fields = publicPlayProfile(uid, playId, playSnap.data() ?? {}, root)
  // Fields no longer on the profile go too; the published key stays.
  const cur = (await playProfileRef(playId).get()).data() ?? {}
  const gone = Object.keys(cur).filter((k) => k !== 'publicPlayKey' && k !== 'updatedAt' && !(k in fields))
  await playProfileRef(playId).set(
    { ...fields, ...Object.fromEntries(gone.map((k) => [k, FieldValue.delete()])), updatedAt: Date.now() },
    { merge: true },
  )
}

const quietly = (uid: string) =>
  refreshPlayProfile(uid).catch((err: unknown) => logger.error('playProfiles: refresh failed', { message: String(err) }))

export const playProfileOnWrite = onDocumentWritten({ document: 'users/{uid}/playProfile/data', memory: '256MiB' }, async (e) => {
  // F-112: contact details masked in the source first; that write re-runs
  // this trigger, which then mirrors the masked text.
  const after = e.data?.after
  if (after?.exists && (await maskProfileDoc(after.ref, after.data(), 'play'))) return
  await quietly(e.params.uid)
})

// The age shown, and deletion.
export const playProfileOnUser = onDocumentWritten({ document: 'users/{uid}', memory: '256MiB' }, async (e) => {
  const b = e.data?.before.data(), a = e.data?.after.data()
  if (b?.age === a?.age && b?.newUntil === a?.newUntil && (b?.isDeleted === true) === (a?.isDeleted === true) && !!b === !!a) return
  if (!(await playIdOf(e.params.uid))) return
  await quietly(e.params.uid)
})

// The app publishes the owner's Play chat key (a separate keypair from the
// Spark one, kept in the browser like it).
export const publishPlayKey = onCall({ timeoutSeconds: 15, invoker: 'public' }, async (request): Promise<{ playId: string }> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  const key: unknown = (request.data as Record<string, unknown> | null)?.publicKey
  // tweetnacl box public keys: 32 bytes, base64.
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new HttpsError('invalid-argument', 'publicKey must be a box public key')
  if (!(await db().doc(`users/${uid}/playProfile/data`).get()).exists) throw new HttpsError('failed-precondition', 'No Play profile')
  const playId = await ensurePlayId(uid)
  await playProfileRef(playId).set({ publicPlayKey: key }, { merge: true })
  return { playId }
})

// The caller's own Play ID (created on first use) — the app names its own
// messages, likes and photos with it in Play. Only with a Play profile.
export const getMyPlayId = onCall({ timeoutSeconds: 15, invoker: 'public' }, async (request): Promise<{ playId: string }> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  if (!(await db().doc(`users/${uid}/playProfile/data`).get()).exists) throw new HttpsError('failed-precondition', 'No Play profile')
  return { playId: await ensurePlayId(uid) }
})
