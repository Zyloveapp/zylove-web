import { useEffect, useState } from 'react'
import { isBotUid } from '../services/zyloveScore'
import { isPlayId } from '../services/playId'
import { loadPlayExtras } from '../services/playProfile'

// Whether a Play ID is a curated profile (its public Play profile says so —
// F-062: a Play ID, unlike a uid, doesn't). Cached for the session.
const curatedPlay = new Map<string, Promise<boolean>>()
function isCuratedPlayId(playId: string): Promise<boolean> {
  let p = curatedPlay.get(playId)
  if (!p) {
    p = loadPlayExtras(playId).then((x) => x.curated, () => false)
    curatedPlay.set(playId, p)
  }
  return p
}

// Zylove's curated launch profiles (bots) are labelled wherever they appear —
// Explore cards, profiles, chats, likes — not only by the Explore banner
// (Stage C). They're removed from a city once its founding circle is full.
// `curated` when the caller already knows (a bot match).
export default function CuratedBadge({ uid, curated, className = '' }: { uid: string | null | undefined; curated?: boolean; className?: string }) {
  const [fromPlay, setFromPlay] = useState<{ id: string; curated: boolean } | null>(null)
  const playId = uid && isPlayId(uid) && curated === undefined ? uid : null
  useEffect(() => {
    if (!playId) return
    let cancelled = false
    void isCuratedPlayId(playId).then((c) => !cancelled && setFromPlay({ id: playId, curated: c }))
    return () => {
      cancelled = true
    }
  }, [playId])
  const show = curated ?? (playId ? fromPlay?.id === playId && fromPlay.curated : !!uid && isBotUid(uid))
  if (!show) return null
  return (
    <span
      title="A Zylove curated profile — shown while your city's community is being built, not a real member."
      className={`inline-block shrink-0 rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-xs font-semibold text-white/70 ${className}`}
    >
      Zylove curated
    </span>
  )
}
