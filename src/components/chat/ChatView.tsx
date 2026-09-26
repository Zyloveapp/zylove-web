import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { MAX_MESSAGE_LENGTH, markMessagesRead, sendMessage, subscribeMessages, type ChatMessage } from '../../services/chat'
import { markMatchRead, type MatchEntry } from '../../services/matches'

function introKey(matchId: string): string {
  return `zylove_chat_intro_dismissed_${matchId}`
}

function introDismissed(matchId: string): boolean {
  try {
    return localStorage.getItem(introKey(matchId)) === '1'
  } catch {
    return false
  }
}

function dismissIntro(matchId: string): void {
  try {
    localStorage.setItem(introKey(matchId), '1')
  } catch {
    // Storage unavailable — the banner hides anyway once a message exists.
  }
}

function messageTime(ms: number | null): string {
  if (ms === null) return 'Sending…'
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
        ' · ' +
        d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

interface ChatViewProps {
  uid: string
  match: MatchEntry
  onBack?: () => void
}

type Loaded = { matchId: string; messages: ChatMessage[]; error: boolean }

export default function ChatView({ uid, match, onBack }: ChatViewProps) {
  const { matchId } = match
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [introHidden, setIntroHidden] = useState(() => introDismissed(matchId))
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Opening the chat counts as reading it (same marker the mobile chat writes).
    markMatchRead(uid, matchId).catch(() => {})
    return subscribeMessages(
      matchId,
      uid,
      (messages) => {
        setLoaded({ matchId, messages, error: false })
        const unreadFromPartner = messages.filter((m) => m.senderId !== uid && m.status !== 'read').map((m) => m.id)
        if (unreadFromPartner.length > 0) {
          markMessagesRead(matchId, unreadFromPartner).catch(() => {})
          markMatchRead(uid, matchId).catch(() => {})
        }
      },
      () => setLoaded({ matchId, messages: [], error: true }),
    )
  }, [matchId, uid])

  const messages = loaded?.matchId === matchId ? loaded.messages : null

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages?.length])

  const trimmed = text.trim()
  const ownBubble = match.mode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
  const showIntro = messages !== null && messages.length === 0 && !introHidden

  async function handleSend(e?: FormEvent) {
    e?.preventDefault()
    if (!trimmed || sending) return
    setSending(true)
    setSendError(null)
    try {
      await sendMessage(matchId, uid, trimmed)
      setText('')
      dismissIntro(matchId)
      setIntroHidden(true)
    } catch {
      setSendError("Couldn't send. Try again.")
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void handleSend()
    }
  }

  return (
    <div className="flex h-full flex-col bg-gray-950 text-white">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3 lg:px-6">
        {onBack && (
          <button type="button" onClick={onBack} className="text-xl text-white/60 hover:text-white lg:hidden" aria-label="Back">
            ←
          </button>
        )}
        {match.photoURL ? (
          <img src={match.photoURL} alt="" className="h-12 w-12 rounded-full object-cover" />
        ) : (
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 font-semibold text-white/70">
            {match.name.charAt(0).toUpperCase()}
          </span>
        )}
        <h2 className="font-semibold">
          {match.name}
          {match.age !== null && <span className="font-normal text-white/50">, {match.age}</span>}
        </h2>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6">
        <div className="flex min-h-full flex-col justify-end gap-3">
          {messages === null ? (
            <div className="flex justify-center py-10">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </div>
          ) : loaded?.error ? (
            <p className="py-10 text-center text-sm text-white/40">Couldn't load messages.</p>
          ) : (
            messages.map((m) => {
              if (m.nonce === 'system') {
                return (
                  <p key={m.id} className="text-center text-xs italic text-white/30">
                    {m.text}
                  </p>
                )
              }
              const own = m.senderId === uid
              const body =
                m.messageType === 'photo' ? '📷 Photo — open the Zylove app to view' : m.text
              return (
                <div key={m.id} className={`flex flex-col ${own ? 'items-end' : 'items-start'}`}>
                  <div
                    className={`max-w-[75%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 ${
                      own ? `${ownBubble} rounded-br-sm text-white` : 'rounded-bl-sm bg-white/10 text-white/90'
                    }`}
                  >
                    {body}
                  </div>
                  <span className="mt-1 text-xs text-white/30">
                    {messageTime(m.sentAt)}
                    {own && m.status === 'read' && ' · Read'}
                  </span>
                </div>
              )
            })
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-white/10 px-4 py-3 lg:px-6">
        {showIntro && (
          <p className="mb-3 rounded-lg bg-white/5 px-4 py-2.5 text-center text-sm text-white/50">
            This is the start of your conversation with {match.name}. Be respectful.
          </p>
        )}
        {sendError && <p className="mb-2 text-center text-sm text-red-400">{sendError}</p>}
        <form onSubmit={handleSend} className="flex items-end gap-2">
          <textarea
            rows={1}
            value={text}
            maxLength={MAX_MESSAGE_LENGTH}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${match.name}…`}
            className="max-h-32 flex-1 resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!trimmed || sending}
            className={`rounded-xl px-5 py-2.5 font-medium text-white transition-opacity disabled:opacity-30 ${ownBubble}`}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  )
}
