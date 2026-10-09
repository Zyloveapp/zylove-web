import { useEffect, useState } from 'react'
import { fetchLikerPreview, type LikerPreview } from '../../services/sparks'

// §4.A3: a like's preview (getLikerPreview, cached per session) —
// undefined while it loads, null if it can't be shown (hidden since, or the
// plan doesn't include it).
export function useLikerPreview(likeId: string, enabled = true): LikerPreview | null | undefined {
  const [loaded, setLoaded] = useState<{ likeId: string; preview: LikerPreview | null } | null>(null)
  useEffect(() => {
    if (!enabled || !likeId) return
    let cancelled = false
    fetchLikerPreview(likeId).then(
      (preview) => !cancelled && setLoaded({ likeId, preview }),
      () => !cancelled && setLoaded({ likeId, preview: null }),
    )
    return () => {
      cancelled = true
    }
  }, [likeId, enabled])
  return loaded?.likeId === likeId ? loaded.preview : undefined
}
