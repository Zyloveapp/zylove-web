import { logger } from 'firebase-functions'
import { getStorage } from 'firebase-admin/storage'
import { storagePath } from './storagePath'

// Profile photos for the AI profile reviews, sent to Claude as base64 image
// blocks — only when the user turned on photo coaching for that mode
// (users/{uid}/private/settings photoAnalysisConsent.spark|play).

export interface ImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

const MAX_PHOTOS = 6
// Claude's per-image limit is 5 MB; base64 adds a third, so stay under it
// once encoded. Uploads aren't resized, so larger photos are skipped.
const MAX_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4)
const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

export function photoConsent(settings: Record<string, unknown> | undefined, mode: 'spark' | 'play'): boolean {
  const consent = settings?.photoAnalysisConsent
  return typeof consent === 'object' && consent !== null && (consent as Record<string, unknown>)[mode] === true
}

// The user's published photos in profile order, as image blocks. Anything
// outside their own photos/{uid}/ folder, in an unsupported format or too
// large is skipped; a photo that fails to load never fails the review.
export async function loadReviewPhotos(uid: string, urls: unknown): Promise<ImageBlock[]> {
  const list = Array.isArray(urls) ? urls.filter((u): u is string => typeof u === 'string' && u !== '') : []
  const blocks = await Promise.all(
    list.slice(0, MAX_PHOTOS).map(async (url): Promise<ImageBlock | null> => {
      const location = storagePath(url)
      if (!location?.path.startsWith(`photos/${uid}/`)) return null
      try {
        const file = getStorage().bucket(location.bucket).file(location.path)
        const [meta] = await file.getMetadata()
        const type = typeof meta.contentType === 'string' ? meta.contentType : ''
        if (!SUPPORTED_TYPES.includes(type) || Number(meta.size) > MAX_BYTES) {
          logger.info('loadReviewPhotos: skipped photo', { type, size: meta.size })
          return null
        }
        const [bytes] = await file.download()
        return { type: 'image', source: { type: 'base64', media_type: type, data: bytes.toString('base64') } }
      } catch (err) {
        logger.warn('loadReviewPhotos: photo failed to load', { message: String(err) })
        return null
      }
    }),
  )
  return blocks.filter((b): b is ImageBlock => b !== null)
}
