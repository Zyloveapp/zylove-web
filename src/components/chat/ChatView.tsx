import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ENCRYPTION_KEY_MISSING, MAX_MESSAGE_LENGTH, markMessagesRead, sendMessage, subscribeMessages, type ChatMessage } from '../../services/chat'
import { decryptMessage } from '../../services/encryption'
import { getPrivateKey, keysReady, subscribePublicKey } from '../../services/keys'
import { markMatchRead, type MatchEntry } from '../../services/matches'
import { markVibeCheckFired, shouldTriggerVibeCheck } from '../../services/vibeCheck'
import {
  REVIEW_MIN_MESSAGES,
  conversationEnded,
  markReviewPromptShown,
  reviewPromptShown,
} from '../../services/zyloveScore'
import ConversationNudge from './ConversationNudge'
import FirstChatModal from './FirstChatModal'
import ReviewModal from './ReviewModal'
import VibeCheckModal from './VibeCheckModal'
import { firstChatSeen } from './firstChatSeen'

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
// key is '' when the partner has no real key (bots, mobile-only users).
type PartnerKey = { partnerUid: string; key: string; error: boolean }

const UNDECRYPTABLE = 'Unable to decrypt message'
const VIBE_CHECK_DELAY_MS = 1500

export default function ChatView({ uid, match, onBack }: ChatViewProps) {
  const { matchId, partnerUid } = match
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [showFirstChat, setShowFirstChat] = useState(() => !firstChatSeen(matchId))
  const [partnerKeyState, setPartnerKeyState] = useState<PartnerKey | null>(null)
  const [myKeyState, setMyKeyState] = useState<{ uid: string; key: string | null } | null>(null)
  const [showVibeCheck, setShowVibeCheck] = useState(false)
  // Fires at most once per open, like mobile's session gate.
  const vibeCheckFired = useRef(false)
  const vibeCheckTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // 'back' = opened by the back button; closing it then leaves the chat.
  const [review, setReview] = useState<'open' | 'back' | null>(null)
  const reviewChecked = useRef(false)
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

  useEffect(
    () =>
      subscribePublicKey(
        partnerUid,
        (key) => setPartnerKeyState({ partnerUid, key, error: false }),
        () => setPartnerKeyState({ partnerUid, key: '', error: true }),
      ),
    [partnerUid],
  )

  useEffect(() => {
    let cancelled = false
    keysReady(uid)
      .then(() => getPrivateKey(uid))
      .then((key) => {
        if (!cancelled) setMyKeyState({ uid, key })
      })
    return () => {
      cancelled = true
    }
  }, [uid])

  const partnerKey = partnerKeyState?.partnerUid === partnerUid ? partnerKeyState : null
  const myPrivateKey = myKeyState?.uid === uid ? myKeyState.key : undefined
  const keysLoaded = partnerKey !== null && myPrivateKey !== undefined
  const rawMessages = loaded?.matchId === matchId ? loaded.messages : null

  // Both sides decrypt with (partner public key, own private key); nacl.box's
  // shared secret is the same in either direction.
  const messages = useMemo(() => {
    if (rawMessages === null || !keysLoaded) return null
    return rawMessages.map((m) => ({
      ...m,
      text: decryptMessage(m.ciphertext, m.nonce, partnerKey.key, myPrivateKey ?? '') ?? UNDECRYPTABLE,
    }))
  }, [rawMessages, keysLoaded, partnerKey, myPrivateKey])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages?.length])

  // Conversation messages only — system notes and photos don't count toward
  // vibe-check milestones (mobile counts text messages).
  const conversation = useMemo(
    () => (messages ?? []).filter((m) => m.nonce !== 'system' && m.messageType === 'text'),
    [messages],
  )

  useEffect(() => {
    if (vibeCheckFired.current || showFirstChat) return
    const senders = conversation.map((m) => m.senderId)
    if (!shouldTriggerVibeCheck(senders, uid, matchId)) return
    vibeCheckFired.current = true
    markVibeCheckFired(matchId, senders.length)
    // Kept in a ref so a message arriving during the delay doesn't cancel it.
    vibeCheckTimer.current = setTimeout(() => setShowVibeCheck(true), VIBE_CHECK_DELAY_MS)
  }, [conversation, showFirstChat, uid, matchId])

  useEffect(() => () => clearTimeout(vibeCheckTimer.current), [])

  // Review prompt: once per match, after a long conversation (never for bots).
  // Shown when leaving via back, or on opening a chat that has gone quiet.
  const reviewEligible =
    conversation.length >= REVIEW_MIN_MESSAGES && !partnerUid.startsWith('zbot-') && !reviewPromptShown(matchId)

  useEffect(() => {
    if (reviewChecked.current || messages === null || showFirstChat) return
    reviewChecked.current = true
    // Never stack on a vibe check fired by this open.
    if (!reviewEligible || vibeCheckFired.current) return
    if (!conversationEnded(conversation[conversation.length - 1]?.sentAt ?? null)) return
    markReviewPromptShown(matchId)
    setReview('open')
  }, [messages, showFirstChat, reviewEligible, conversation, matchId])

  function handleBack() {
    if (reviewEligible && review === null && !showVibeCheck) {
      markReviewPromptShown(matchId)
      setReview('back')
      return
    }
    onBack?.()
  }

  function closeReview() {
    const leaving = review === 'back'
    setReview(null)
    if (leaving) onBack?.()
  }

  const trimmed = text.trim()
  const ownBubble = match.mode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
  // Never fall back to plaintext just because the partner's key failed to load.
  const canSend = partnerKey !== null && !partnerKey.error

  async function handleSend(e?: FormEvent) {
    e?.preventDefault()
    if (!trimmed || sending || !canSend) return
    setSending(true)
    setSendError(null)
    try {
      await sendMessage(matchId, uid, trimmed, partnerKey.key)
      setText('')
    } catch (err) {
      setSendError(
        err instanceof Error && err.message === ENCRYPTION_KEY_MISSING
          ? 'Unable to send — your encryption key is missing. Try signing out and back in.'
          : "Couldn't send. Try again.",
      )
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
    // Mobile: full-screen over the bottom nav, sized to the dynamic viewport so
    // the keyboard shrinks the message list instead of exposing the page below.
    // Desktop: fills its pane.
    <div className="fixed inset-0 z-50 flex h-[100dvh] flex-col overscroll-none bg-gray-950 text-white lg:static lg:z-auto lg:h-full">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3 lg:px-6">
        {onBack && (
          <button type="button" onClick={handleBack} className="text-xl text-white/60 hover:text-white lg:hidden" aria-label="Back">
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

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 lg:px-6">
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

      <div className="shrink-0 border-t border-white/10 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] lg:px-6">
        <ConversationNudge
          matchId={matchId}
          partnerUid={partnerUid}
          messages={conversation}
          suppressed={showFirstChat || showVibeCheck || review !== null}
          onPick={setText}
        />
        {sendError && <p className="mb-2 text-center text-sm text-red-400">{sendError}</p>}
        {partnerKey?.error && (
          <p className="mb-2 text-center text-sm text-red-400">Couldn't load encryption keys. Reopen the chat to retry.</p>
        )}
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
            disabled={!trimmed || sending || !canSend}
            className={`rounded-xl px-5 py-2.5 font-medium text-white transition-opacity disabled:opacity-30 ${ownBubble}`}
          >
            Send
          </button>
        </form>
      </div>

      {showFirstChat && (
        <FirstChatModal matchId={matchId} name={match.name} onClose={() => setShowFirstChat(false)} />
      )}

      {showVibeCheck && (
        <VibeCheckModal
          matchId={matchId}
          partnerUid={partnerUid}
          name={match.name}
          onClose={() => setShowVibeCheck(false)}
          onUseOpener={setText}
        />
      )}

      {review !== null && (
        <ReviewModal matchId={matchId} partnerUid={partnerUid} name={match.name} onClose={closeReview} />
      )}
    </div>
  )
}
