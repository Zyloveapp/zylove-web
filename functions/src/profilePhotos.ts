import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { getStorage } from 'firebase-admin/storage'
import { getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { playIdOf } from './playIds'
import { accountRef, internalRef } from './userData'
import { heldUrls, isKeptHold } from './photoHolds'

// Deleting a Spark or Play profile also deletes that mode's photo files —
// everything under photos/{uid}/{mode}/, published, pending or orphaned.
// Server-side because the Storage rules let users delete their own files but
// not list a folder. The profile docs themselves are cleared client-side.
// F-081: that mode's photos waiting for review leave the owner's queue here
// too (the rules no longer let the owner touch it) — except holds kept for
// review (content flags, blocklist matches; photoHolds.ts), which stay, files
// and all, until an admin decides them.
export const deleteModePhotos = onCall(
  { timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const mode = (request.data as { mode?: unknown } | null)?.mode
    if (mode !== 'spark' && mode !== 'play') throw new HttpsError('invalid-argument', 'mode must be spark or play')
    // F-062: Play photos are under the Play ID (and older ones under the uid).
    const playId = mode === 'play' ? await playIdOf(uid) : null
    const prefixes = [`photos/${uid}/${mode}/`, ...(playId ? [`playPhotos/${playId}/`] : [])]
    const inMode = (url: string) => prefixes.some((p) => url.startsWith(p))

    const kept = await getFirestore().runTransaction(async (tx) => {
      const pending = ((await tx.get(accountRef(uid))).data()?.pendingPhotoURLs ?? []) as DocumentData[]
      if (!Array.isArray(pending)) return new Set<string>()
      const next = pending.filter((p) => typeof p?.url !== 'string' || !inMode(p.url) || isKeptHold(p.reason))
      if (next.length !== pending.length) {
        tx.set(accountRef(uid), { pendingPhotoURLs: next }, { merge: true })
        if (next.length === 0) tx.set(internalRef(uid), { hasPendingPhotos: false }, { merge: true })
      }
      return new Set(next.map((p) => p?.url).filter((u): u is string => typeof u === 'string'))
    })
    for (const url of await heldUrls(uid)) kept.add(url)

    try {
      const bucket = getStorage().bucket()
      for (const prefix of prefixes) {
        const [files] = await bucket.getFiles({ prefix })
        await Promise.all(files.filter((f) => !kept.has(f.name)).map((f) => f.delete({ ignoreNotFound: true })))
      }
    } catch (err) {
      logger.error('deleteModePhotos: Storage delete failed', { mode, message: String(err) })
      throw new HttpsError('internal', "Couldn't delete photos")
    }
    return { success: true }
  },
)
