// Bucket and object path from a stored photo reference: a Storage path
// ("photos/{uid}/{mode}/{file}", or a Play photo's playPhotos/{playId}/{file},
// in the default bucket — what Firestore holds since Stage 1b), or either older URL shape: onPhotoUpload's signed URLs
// (storage.googleapis.com/{bucket}/{path}) or Firebase download URLs
// (firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}).
// The project's default bucket (FIREBASE_CONFIG is set by the Functions
// runtime and the emulator).
export function defaultBucket(): string {
  try {
    const b: unknown = JSON.parse(process.env.FIREBASE_CONFIG ?? '{}').storageBucket
    if (typeof b === 'string' && b) return b
  } catch {
    // fall through
  }
  return 'zylove.firebasestorage.app'
}

// F-062: Play photos are stored under the Play ID — playPhotos/{playId}/{file}
// — never the uid. (photos/{uid}/play/… is the shape before F-062.)
export function isPlayPhotoRef(v: unknown): v is string {
  return typeof v === 'string' && /^playPhotos\/p_[A-Za-z0-9]{20}\/[^/]+$/.test(v)
}

export function isPhotoRef(v: unknown): v is string {
  return typeof v === 'string' && (/^photos\/[^/]+\/(spark|play)\/[^/]+$/.test(v) || isPlayPhotoRef(v))
}

export function storagePath(url: string): { bucket: string; path: string } | null {
  if (isPhotoRef(url)) return { bucket: defaultBucket(), path: url }
  try {
    const u = new URL(url)
    if (u.hostname === 'storage.googleapis.com') {
      const [bucket, ...rest] = u.pathname.slice(1).split('/')
      return bucket && rest.length ? { bucket, path: decodeURIComponent(rest.join('/')) } : null
    }
    const m = /^\/v0\/b\/([^/]+)\/o\/(.+)$/.exec(u.pathname)
    return m ? { bucket: m[1], path: decodeURIComponent(m[2]) } : null
  } catch {
    return null
  }
}
