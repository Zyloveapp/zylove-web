import { useEffect, useState } from 'react'
import { loadPlayIdentity, type PlayIdentity } from '../../services/matches'

// In Play: the person's Play name and photo (undefined while loading, so a
// Spark photo never flashes). In Spark: null — use what you already have.
export function usePlayIdentity(uid: string, play: boolean): PlayIdentity | null | undefined {
  const [loaded, setLoaded] = useState<{ uid: string; identity: PlayIdentity } | null>(null)
  useEffect(() => {
    if (!play || !uid) return
    let cancelled = false
    loadPlayIdentity(uid).then((identity) => !cancelled && setLoaded({ uid, identity }))
    return () => {
      cancelled = true
    }
  }, [uid, play])
  if (!play) return null
  return loaded?.uid === uid ? loaded.identity : undefined
}
