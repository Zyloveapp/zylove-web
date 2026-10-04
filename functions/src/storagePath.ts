// Bucket and object path from either URL shape: onPhotoUpload's signed URLs
// (storage.googleapis.com/{bucket}/{path}) or Firebase download URLs
// (firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}).
export function storagePath(url: string): { bucket: string; path: string } | null {
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
