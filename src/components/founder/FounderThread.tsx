import { useEffect, useRef, useState } from 'react'
import { FOUNDER_MESSAGE_MAX, formatMessageTime, type FounderMessage } from '../../services/founderMessages'

// Chat layout shared by the founder's page and the admin inbox: your own
// messages on the right in a solid bubble, the other side on the left in a
// dark card with the sender's name.
export function FounderThreadView({
  messages,
  viewer,
  bubble,
  empty,
}: {
  messages: FounderMessage[]
  viewer: 'founder' | 'admin'
  // Your own bubbles: cobalt, or red for a founder in Play.
  bubble: string
  empty: string
}) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [messages.length])

  if (messages.length === 0) return <p className="px-6 py-12 text-center text-sm text-white/50">{empty}</p>
  return (
    <ul className="space-y-3 px-4 py-4">
      {messages.map((m) => {
        const mine = viewer === 'admin' ? m.isFromAdmin : !m.isFromAdmin
        return (
          <li key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
            {mine ? (
              <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-4 py-2.5 text-sm text-white ${bubble}`}>
                {m.body}
              </div>
            ) : (
              <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-white/10 border-l-2 border-l-[#1B4FD8] bg-gray-900 px-4 py-2.5 text-sm text-white">
                <p className="mb-1 text-xs font-semibold text-[#7C9BFF]">{m.fromName}</p>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </div>
            )}
            <span className="mt-1 px-1 text-[11px] text-white/30">{formatMessageTime(m.createdAt)}</span>
          </li>
        )
      })}
      <div ref={end} />
    </ul>
  )
}

// Textarea + counter + send. onSend rejects on failure; the text is kept.
export function FounderComposer({
  placeholder,
  button,
  onSend,
}: {
  placeholder: string
  button: string
  onSend: (body: string) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = text.trim()

  async function send() {
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSend(trimmed)
      setText('')
    } catch {
      setError("Couldn't send. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
      className="border-t border-white/10 bg-gray-950 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, FOUNDER_MESSAGE_MAX))}
        placeholder={placeholder}
        rows={3}
        maxLength={FOUNDER_MESSAGE_MAX}
        className="w-full resize-none rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-[#1B4FD8]/60 focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-xs text-white/40">
          {text.length}/{FOUNDER_MESSAGE_MAX}
        </span>
        {error && <span className="flex-1 text-xs text-red-400">{error}</span>}
        <button
          type="submit"
          disabled={!trimmed || busy}
          className="rounded-xl bg-[#1B4FD8] px-5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Sending…' : button}
        </button>
      </div>
    </form>
  )
}
