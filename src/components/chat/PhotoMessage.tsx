import { useEffect, useState } from 'react'
import type { PhotoPayload } from '../../services/chat'
import { markPhotoViewed, openPhoto } from '../../services/photos'

interface PhotoMessageProps {
  matchId: string
  messageId: string
  photo: PhotoPayload
  isMine: boolean
  uid: string
  partnerPublicKey: string
  // Play gets its own icons on the tap-to-view card and destructed notice.
  mode: 'spark' | 'play'
}

type Decrypted = { key: string; url: string | null }

// Downloads + decrypts while `enabled`; the object URL is revoked when it's
// no longer shown. The photo only ever exists decrypted in memory.
function useDecryptedPhoto(enabled: boolean, props: PhotoMessageProps): string | null | undefined {
  const { photo, isMine, uid, partnerPublicKey, messageId } = props
  const key = `${messageId}:${photo.storageRef}:${partnerPublicKey}`
  const [result, setResult] = useState<Decrypted | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let url: string | null = null
    openPhoto(photo, isMine, uid, partnerPublicKey).then((u) => {
      url = u
      if (cancelled) {
        if (u) URL.revokeObjectURL(u)
      } else {
        setResult({ key, url: u })
      }
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
    // photo fields that matter are folded into key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key])

  if (!enabled) return null
  return result?.key === key ? result.url : undefined // undefined = still decrypting
}

const bubble = 'max-w-[75%] rounded-2xl px-4 py-2.5 text-sm'

export default function PhotoMessage(props: PhotoMessageProps) {
  const { matchId, messageId, photo, isMine, mode } = props
  const play = mode === 'play'
  const [now, setNow] = useState(() => Date.now())
  const [viewing, setViewing] = useState(false)
  const [viewError, setViewError] = useState(false)

  const timed = photo.timerSeconds > 0
  const expired =
    photo.destructedAt !== null || photo.storageRef === null || (photo.photoExpiresAt !== null && photo.photoExpiresAt <= now)
  const counting = timed && photo.photoExpiresAt !== null && !expired
  const remaining = photo.photoExpiresAt !== null ? Math.max(0, Math.ceil((photo.photoExpiresAt - now) / 1000)) : 0

  useEffect(() => {
    if (!counting) return
    const tick = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(tick)
  }, [counting])

  // Sender of a timed photo never sees it again; recipient sees it only
  // once the server has started the timer.
  const showsImage = !expired && (!timed || (!isMine && photo.firstViewedAt !== null))
  const url = useDecryptedPhoto(showsImage, props)

  if (expired) return <div className={`${bubble} bg-white/5 text-white/40`}>{play ? '🔥' : '📸'} Photo destructed</div>

  if (timed && isMine) {
    return (
      <div className={`${bubble} border border-white/15 bg-white/5 text-white/70`}>
        {photo.firstViewedAt === null
          ? `📸 Photo sent · Destructs ${photo.timerSeconds}s after view`
          : `📸 Photo viewed · Destructing in ${remaining}s`}
      </div>
    )
  }

  if (timed && photo.firstViewedAt === null) {
    async function view() {
      setViewing(true)
      setViewError(false)
      try {
        await markPhotoViewed(matchId, messageId)
        // The snapshot listener delivers firstViewedAt and the photo opens.
      } catch {
        setViewError(true)
        setViewing(false)
      }
    }
    return (
      <button
        type="button"
        onClick={view}
        disabled={viewing}
        className="flex w-56 flex-col items-center gap-1 rounded-2xl border border-white/15 bg-white/5 px-4 py-6 text-center hover:bg-white/10 disabled:opacity-70"
      >
        {viewing ? (
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        ) : (
          <span className="text-2xl" aria-hidden>
            {play ? '😈' : '📷'}
          </span>
        )}
        <span className="text-sm font-semibold">{viewError ? "Couldn't open it. Tap to retry." : 'Tap to view photo'}</span>
        {!viewError && <span className="text-xs text-white/40">Destructs {photo.timerSeconds}s after you view</span>}
      </button>
    )
  }

  if (url === undefined) {
    return (
      <div className="flex h-48 w-56 items-center justify-center rounded-2xl bg-white/5">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" aria-label="Decrypting photo" />
      </div>
    )
  }
  if (url === null) return <div className={`${bubble} bg-white/5 text-white/40`}>Unable to display photo</div>

  return (
    <div className="relative max-w-[75%] overflow-hidden rounded-2xl">
      <img
        src={url}
        alt="Photo"
        draggable={false}
        onContextMenu={(e) => e.preventDefault()}
        className="max-h-96 w-auto select-none object-cover"
      />
      {counting && (
        <span className="absolute right-2 bottom-2 rounded-full bg-black/60 px-2 py-1 text-sm font-bold text-white">
          {remaining}s
        </span>
      )}
    </div>
  )
}
