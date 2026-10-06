import { useEffect, useState } from 'react'
import { cachedPhoto, forgetPhoto, isPhotoRef, resolvePhoto } from '../services/photoUrls'

// A displayable URL for a stored photo value (services/photoUrls.ts):
// undefined while loading, null when the viewer may not see it. retry()
// fetches a fresh URL once (an image that failed to load: expired).
export function usePhotoUrl(src: string | null | undefined): { url: string | null | undefined; retry: () => void } {
  const value = src ?? ''
  const [resolved, setResolved] = useState<{ value: string; url: string | null } | null>(null)
  const [retried, setRetried] = useState<string | null>(null)
  const cached = value ? cachedPhoto(value) : null

  useEffect(() => {
    if (!value || cached !== undefined) return
    let cancelled = false
    void resolvePhoto(value).then((url) => !cancelled && setResolved({ value, url }))
    return () => {
      cancelled = true
    }
  }, [value, cached])

  const url = !value ? null : cached !== undefined ? cached : resolved?.value === value ? resolved.url : undefined
  function retry() {
    if (!isPhotoRef(value) || retried === value) return
    setRetried(value)
    forgetPhoto(value)
    void resolvePhoto(value).then((u) => setResolved({ value, url: u }))
  }
  return { url, retry }
}
