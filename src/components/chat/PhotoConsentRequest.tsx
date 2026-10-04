import type { ConsentCode } from '../../services/chat'
import type { Mode } from '../../store/modeStore'

interface PhotoConsentRequestProps {
  code: ConsentCode
  // The chat's mode (not the app's current one).
  mode: Mode
  isMine: boolean
  partnerName: string
  // Only the newest request, while still pending, can be answered.
  live: boolean
  busy: boolean
  onRespond: (accept: boolean) => void
}

// System card for a photo-consent message.
export default function PhotoConsentRequest({ code, mode, isMine, partnerName, live, busy, onRespond }: PhotoConsentRequestProps) {
  // Play: red accent and consent button; Spark keeps cobalt.
  const play = mode === 'play'
  const card = `mx-auto w-full max-w-sm rounded-2xl border px-4 py-3 text-center ${
    play ? 'border-[#E03131]/30 bg-[#E03131]/[0.06]' : 'border-white/10 bg-white/5'
  }`

  if (code === 'photo_consent_accepted') {
    return (
      <div className={card}>
        <p className="font-semibold">📸 Photo sharing unlocked</p>
        <p className="mt-1 text-xs text-white/40">Photos are end-to-end encrypted.</p>
      </div>
    )
  }
  if (code === 'photo_consent_declined') {
    return (
      <div className={card}>
        <p className="font-semibold text-white/70">🙅 Photo sharing declined</p>
        <p className="mt-1 text-xs text-white/40">Either person can send a new request anytime.</p>
      </div>
    )
  }
  if (code === 'photo_consent_paused') {
    return (
      <div className={card}>
        <p className="font-semibold text-white/70">⏸️ Photo sharing paused</p>
      </div>
    )
  }

  // A request.
  if (isMine) {
    return (
      <div className={card}>
        <p className="text-sm text-white/60">
          {live ? `Waiting for ${partnerName} to accept…` : 'You asked to share photos'}
        </p>
      </div>
    )
  }
  return (
    <div className={card}>
      <p className="font-semibold">📷 {partnerName} wants to share photos</p>
      {live && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => onRespond(false)}
            disabled={busy}
            className="flex-1 rounded-full border border-white/15 py-2 text-sm font-medium text-white/70 hover:bg-white/5 disabled:opacity-50"
          >
            Not right now
          </button>
          <button
            type="button"
            onClick={() => onRespond(true)}
            disabled={busy}
            className={`flex-1 rounded-full py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 ${
              play ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
            }`}
          >
            Yes, I consent
          </button>
        </div>
      )}
    </div>
  )
}
