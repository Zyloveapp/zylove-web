import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { ENCRYPTION_KEYS_UNAVAILABLE } from '../../services/encryption'
import { PHOTO_TIMERS, PHOTO_UNREADABLE, preparePhoto, sendEncryptedPhoto, type PhotoTimer } from '../../services/photos'

interface PhotoPickerProps {
  matchId: string
  uid: string
  partnerUid: string
  onClose: () => void
}

// Pick, preview, choose a timer, send. Timers are open to every web user
// for now (no paywall yet).
export default function PhotoPicker({ matchId, uid, partnerUid, onClose }: PhotoPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [timer, setTimer] = useState<PhotoTimer>(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!file) return
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape' && !sending) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sending, onClose])

  function choose(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (!picked) return
    setError(null)
    setFile(picked)
  }

  async function send() {
    if (!file || sending) return
    setSending(true)
    setError(null)
    try {
      const bytes = await preparePhoto(file)
      await sendEncryptedPhoto(matchId, uid, partnerUid, bytes, timer)
      onClose()
    } catch (err) {
      const code = err instanceof Error ? err.message : ''
      setError(
        code === PHOTO_UNREADABLE
          ? "Couldn't read that photo. Try a JPEG or PNG."
          : code === ENCRYPTION_KEYS_UNAVAILABLE
            ? "Photos can't be encrypted for this chat right now. Try signing out and back in."
            : "Couldn't send the photo. Try again.",
      )
      setSending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="photo-picker-title"
    >
      <div className="max-h-[95dvh] w-full overflow-y-auto rounded-t-2xl bg-gray-900 px-6 pt-5 text-white pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] lg:max-w-md lg:rounded-2xl lg:pb-6">
        <div className="flex items-center justify-between">
          <button type="button" onClick={onClose} disabled={sending} className="text-sm text-white/50 hover:text-white disabled:opacity-40">
            Cancel
          </button>
          <h2 id="photo-picker-title" className="font-semibold">
            Share a photo
          </h2>
          <span className="w-12" />
        </div>
        <p className="mt-4 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-center text-xs text-white/60">
          🔒 End-to-end encrypted · Consent granted
        </p>

        <input ref={inputRef} type="file" accept="image/*" onChange={choose} className="hidden" />
        {preview ? (
          <div className="mt-4 flex flex-col items-center">
            <img src={preview} alt="Selected photo" className="max-h-72 rounded-2xl object-contain" />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={sending}
              className="mt-2 text-sm text-white/50 hover:text-white"
            >
              Change photo
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            autoFocus
            className="mt-4 flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-white/20 py-10 text-white/60 hover:bg-white/5"
          >
            <span className="text-3xl" aria-hidden>
              🖼️
            </span>
            <span className="text-sm font-medium">Choose a photo</span>
          </button>
        )}

        <h3 className="mt-6 text-sm font-semibold">Photo timer</h3>
        <p className="text-xs text-white/40">Photo disappears this long after they view it</p>
        <div className="mt-2 grid grid-cols-4 gap-2" role="radiogroup" aria-label="Photo timer">
          {PHOTO_TIMERS.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={timer === t}
              onClick={() => setTimer(t)}
              disabled={sending}
              className={`rounded-full border py-2 text-xs font-semibold transition-colors ${
                timer === t ? 'border-[#1B4FD8] bg-[#1B4FD8] text-white' : 'border-white/15 text-white/60 hover:bg-white/5'
              }`}
            >
              {t === 0 ? 'No timer' : `${t}s`}
            </button>
          ))}
        </div>

        {error && <p className="mt-4 text-center text-sm text-red-400">{error}</p>}
        <button
          type="button"
          onClick={send}
          disabled={!file || sending}
          className="mt-6 w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {sending ? 'Encrypting & sending…' : timer > 0 ? `Send · disappears in ${timer}s` : 'Send photo'}
        </button>
        <p className="mt-3 text-center text-xs text-white/40">
          Sending content that violates community guidelines may result in account suspension.
        </p>
      </div>
    </div>
  )
}
