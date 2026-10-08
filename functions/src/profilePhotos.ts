import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { getStorage } from 'firebase-admin/storage'
import { playIdOf } from './playIds'

// Deleting a Spark or Play profile also deletes that mode's photo files —
// everything under photos/{uid}/{mode}/, published, pending or orphaned.
// Server-side because the Storage rules let users delete their own files but
// not list a folder. The profile docs themselves are cleared client-side.
export const deleteModePhotos = onCall(
  { timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ success: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const mode = (request.data as { mode?: unknown } | null)?.mode
    if (mode !== 'spark' && mode !== 'play') throw new HttpsError('invalid-argument', 'mode must be spark or play')
    // F-062: Play photos are under the Play ID (and older ones under the uid).
    const playId = mode === 'play' ? await playIdOf(request.auth.uid) : null
    const prefixes = [`photos/${request.auth.uid}/${mode}/`, ...(playId ? [`playPhotos/${playId}/`] : [])]
    try {
      for (const prefix of prefixes) await getStorage().bucket().deleteFiles({ prefix, force: true })
    } catch (err) {
      logger.error('deleteModePhotos: Storage delete failed', { mode, message: String(err) })
      throw new HttpsError('internal', "Couldn't delete photos")
    }
    return { success: true }
  },
)
