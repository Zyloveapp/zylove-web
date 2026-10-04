import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ENCRYPTION_KEY_MISSING,
  MAX_MESSAGE_LENGTH,
  consentCode,
  markMessagesRead,
  sendMessage,
  subscribeMessages,
  type ChatMessage,
} from '../../services/chat'
import { decryptMessage } from '../../services/encryption'
import { getPrivateKey, keysReady, subscribePublicKey } from '../../services/keys'
import { markMatchRead, type MatchEntry } from '../../services/matches'
import { markVibeCheckFired, shouldTriggerVibeCheck } from '../../services/vibeCheck'
import { clearTyping, setTyping, subscribeTyping } from '../../services/typing'
import {
  coldReviewShown,
  conversationCold,
  isBotUid,
  markColdReviewShown,
  markReviewed,
  reviewed,
} from '../../services/zyloveScore'
import { blockMatch, unmatch } from '../../services/safety'
import {
  markPhotoBannerSeen,
  pausePhotoSharing,
  photoBannerSeen,
  requestPhotoConsent,
  respondToPhotoConsent,
  subscribePhotoConsent,
  type PhotoConsent,
} from '../../services/photos'
import ChatActionsSheet, { type ChatAction } from './ChatActionsSheet'
import ConversationNudge from './ConversationNudge'
import FirstChatModal from './FirstChatModal'
import PhotoConsentBanner from './PhotoConsentBanner'
import PhotoConsentRequest from './PhotoConsentRequest'
import PhotoMessage from './PhotoMessage'
import PhotoPicker from './PhotoPicker'
import CameraIcon from '../icons/CameraIcon'
import { PaywallModal, useCanAccess } from '../PaywallGate'
import TypingIndicator from './TypingIndicator'
import ReviewModal from './ReviewModal'
import VibeCheckModal from './VibeCheckModal'
import { firstChatSeen, firstChatSeenRemotely } from './firstChatSeen'
import { fetchPublicUserDoc } from '../../services/publicUserDoc'

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
// Own typing: write at most every 2s, clear after 3s idle. Partner's counts
// as typing while their typingAt is under 5s old.
const TYPING_WRITE_MS = 2000
const TYPING_IDLE_MS = 3000
const TYPING_FRESH_MS = 5000
const VIBE_CHECK_DELAY_MS = 1500

export default function ChatView({ uid, match, onBack }: ChatViewProps) {
  const { matchId, partnerUid } = match
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // The first-chat card promises "You're talking to a real human", so it's
  // never shown for demonstration profiles — known by uid prefix right away,
  // or by isBot on their user doc (checked before the card appears).
  const [showFirstChat, setShowFirstChat] = useState(() => !firstChatSeen(matchId) && !isBotUid(partnerUid))
  const [humanPartner, setHumanPartner] = useState<string | null>(null)
  const [partnerKeyState, setPartnerKeyState] = useState<PartnerKey | null>(null)
  const [myKeyState, setMyKeyState] = useState<{ uid: string; key: string | null } | null>(null)
  const [showVibeCheck, setShowVibeCheck] = useState(false)
  // Fires at most once per open, like mobile's session gate.
  const vibeCheckFired = useRef(false)
  const vibeCheckTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [showReview, setShowReview] = useState(false)
  const [showActions, setShowActions] = useState(false)
  const [showReport, setShowReport] = useState(false)
  // Block/unmatch done: the review card, then back to the list.
  const [exitReview, setExitReview] = useState(false)
  const [consentState, setConsentState] = useState<{ matchId: string; consent: PhotoConsent | null } | null>(null)
  const [showPhotoBanner, setShowPhotoBanner] = useState(false)
  const [showPhotoPicker, setShowPhotoPicker] = useState(false)
  const [photoNotice, setPhotoNotice] = useState<{ text: string; offerRequest: boolean } | null>(null)
  const [consentBusy, setConsentBusy] = useState(false)
  const photosAllowed = useCanAccess('photo_sharing')
  const [photoPaywall, setPhotoPaywall] = useState(false)
  const navigate = useNavigate()
  const reviewChecked = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastTypingWrite = useRef(0)
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [partnerTypingAt, setPartnerTypingAt] = useState<{ matchId: string; at: number | null } | null>(null)
  const [now, setNow] = useState(() => Date.now())

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
    () => subscribePhotoConsent(matchId, (consent) => setConsentState({ matchId, consent })),
    [matchId],
  )

  useEffect(() => {
    if (isBotUid(partnerUid)) return
    let cancelled = false
    fetchPublicUserDoc(partnerUid).then((partner) => {
      if (cancelled) return
      if (partner?.isBot === true) setShowFirstChat(false)
      else setHumanPartner(partnerUid)
    })
    return () => {
      cancelled = true
    }
  }, [partnerUid])

  // Hide the first-chat modal if it was already dismissed on mobile.
  useEffect(() => {
    if (firstChatSeen(matchId)) return
    let cancelled = false
    firstChatSeenRemotely(matchId).then((seen) => {
      if (seen && !cancelled) setShowFirstChat(false)
    })
    return () => {
      cancelled = true
    }
  }, [matchId])

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

  // Review prompt, "gone cold" trigger: once per match, on opening a chat
  // that's been quiet 30+ days after 10+ messages. Never while a conversation
  // is active; ended matches are handled app-wide by ReviewPrompter.
  useEffect(() => {
    if (reviewChecked.current || messages === null || showFirstChat) return
    reviewChecked.current = true
    // Never stack on a vibe check fired by this open.
    if (vibeCheckFired.current || isBotUid(partnerUid) || reviewed(matchId) || coldReviewShown(matchId)) return
    if (!conversationCold(conversation[conversation.length - 1]?.sentAt ?? null, conversation.length)) return
    markColdReviewShown(matchId)
    setShowReview(true)
  }, [messages, showFirstChat, conversation, partnerUid, matchId])

  // Leaving the chat (or switching matches) clears our typing status.
  useEffect(
    () => () => {
      clearTimeout(typingIdleTimer.current)
      lastTypingWrite.current = 0
      clearTyping(matchId, uid).catch(() => {})
    },
    [matchId, uid],
  )

  useEffect(
    () => subscribeTyping(matchId, partnerUid, (at) => setPartnerTypingAt({ matchId, at })),
    [matchId, partnerUid],
  )

  const partnerTyping = partnerTypingAt?.matchId === matchId ? partnerTypingAt.at : null
  // Re-check freshness every second while a typing doc exists, in case the
  // partner's delete never lands (closed tab, lost connection).
  useEffect(() => {
    if (partnerTyping === null) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [partnerTyping])
  const showTyping = partnerTyping !== null && now - partnerTyping < TYPING_FRESH_MS

  useEffect(() => {
    if (showTyping) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [showTyping])

  function stopTyping() {
    clearTimeout(typingIdleTimer.current)
    if (lastTypingWrite.current === 0) return
    lastTypingWrite.current = 0
    clearTyping(matchId, uid).catch(() => {})
  }

  function handleTextChange(value: string) {
    setText(value)
    if (!value.trim()) return stopTyping()
    const t = Date.now()
    if (t - lastTypingWrite.current >= TYPING_WRITE_MS) {
      lastTypingWrite.current = t
      setTyping(matchId, uid).catch(() => {})
    }
    clearTimeout(typingIdleTimer.current)
    typingIdleTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS)
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
    stopTyping()
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

  // ── Photo sharing ──────────────────────────────────────────────────────────
  const consent = consentState?.matchId === matchId ? consentState.consent : null
  // The camera shows in every live chat; photos only go to real people.
  // Photos are always encrypted, so sending also needs the partner's real
  // key — mobile-only users have a stubbed one until they sign in on the
  // web — and tapping explains that.
  const botChat = isBotUid(partnerUid)
  const photosAvailable = !match.ended && !botChat
  const partnerCanReceivePhotos = partnerKey !== null && partnerKey.key !== ''
  const latestRequestId = useMemo(
    () => [...(messages ?? [])].reverse().find((m) => consentCode(m) === 'photo_consent_request')?.id ?? null,
    [messages],
  )

  async function runConsent(action: () => Promise<void>) {
    setConsentBusy(true)
    setPhotoNotice(null)
    try {
      await action()
    } catch {
      setPhotoNotice({ text: "Couldn't update photo sharing. Try again.", offerRequest: false })
    } finally {
      setConsentBusy(false)
    }
  }

  function startRequest() {
    if (photoBannerSeen(matchId)) void runConsent(() => requestPhotoConsent(matchId, uid))
    else setShowPhotoBanner(true)
  }

  function handlePhotoTap() {
    setPhotoNotice(null)
    if (botChat) {
      return setPhotoNotice({ text: 'Photo sharing is available with members, not curated profiles.', offerRequest: false })
    }
    // Free: 📷 still shows, but sending photos is Spark+.
    if (photosAllowed === false) return setPhotoPaywall(true)
    if (!partnerCanReceivePhotos) {
      return setPhotoNotice({
        text:
          partnerKey === null
            ? 'Loading encryption keys — try again in a moment.'
            : `${match.name} needs to sign in to Zylove on the web before you can share encrypted photos.`,
        offerRequest: false,
      })
    }
    switch (consent?.status) {
      case 'accepted':
        return setShowPhotoPicker(true)
      case 'pending':
        return setPhotoNotice({
          text:
            consent.requestedBy === uid
              ? `Waiting for ${match.name} to accept`
              : `${match.name} asked to share photos — answer above.`,
          offerRequest: false,
        })
      case 'declined':
      case 'paused':
        return setPhotoNotice({ text: 'Photo sharing is paused. Send a new request?', offerRequest: true })
      default:
        return startRequest()
    }
  }

  function leave() {
    onBack?.()
    navigate('/matches')
  }

  async function endConnection(action: Exclude<ChatAction, 'report'>) {
    if (action === 'block') await blockMatch(matchId, partnerUid)
    else await unmatch(matchId, uid)
    setShowActions(false)
    // Same rules as the app-wide prompt: a real person, a real conversation,
    // not already reviewed.
    if (!isBotUid(partnerUid) && conversation.length > 0 && !reviewed(matchId)) setExitReview(true)
    else leave()
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
          <button type="button" onClick={onBack} className="text-xl text-white/60 hover:text-white lg:hidden" aria-label="Back">
            ←
          </button>
        )}
        {/* Name and avatar open their profile; ••• (right) holds Report/Block/Unmatch. */}
        <button
          type="button"
          onClick={() => navigate(`/profile/${partnerUid}`)}
          aria-label={`View ${match.name}'s profile`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left transition-opacity hover:opacity-80"
        >
          {match.photoURL ? (
            <img src={match.photoURL} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/10 font-semibold text-white/70">
              {match.name.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="min-w-0 truncate font-semibold">
            {match.name}
            {match.age !== null && <span className="font-normal text-white/50">, {match.age}</span>}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setShowActions(true)}
          aria-label="More options"
          className="shrink-0 rounded-full px-2 py-1 text-xl leading-none text-white/60 hover:bg-white/10 hover:text-white"
        >
          •••
        </button>
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
              const code = consentCode(m)
              if (code) {
                return (
                  <PhotoConsentRequest
                    key={m.id}
                    code={code}
                    isMine={m.senderId === uid}
                    partnerName={match.name}
                    live={m.id === latestRequestId && consent?.status === 'pending'}
                    busy={consentBusy}
                    onRespond={(accept) => void runConsent(() => respondToPhotoConsent(matchId, uid, accept))}
                  />
                )
              }
              if (m.messageType === 'photo' && m.photo) {
                const own = m.senderId === uid
                return (
                  <div key={m.id} className={`flex flex-col ${own ? 'items-end' : 'items-start'}`}>
                    <PhotoMessage
                      matchId={matchId}
                      messageId={m.id}
                      photo={m.photo}
                      isMine={own}
                      uid={uid}
                      partnerPublicKey={partnerKey?.key ?? ''}
                    />
                    <span className="mt-1 text-xs text-white/30">{messageTime(m.sentAt)}</span>
                  </div>
                )
              }
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
          <TypingIndicator visible={showTyping} mode={match.mode} />
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-white/10 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] lg:px-6">
        <ConversationNudge
          matchId={matchId}
          partnerUid={partnerUid}
          mode={match.mode === 'play' ? 'play' : 'spark'}
          messages={conversation}
          suppressed={showFirstChat || showVibeCheck || showReview || showReport || exitReview || showPhotoPicker || showPhotoBanner}
          onPick={setText}
        />
        {photoNotice && (
          <div className="mb-2 flex items-center justify-center gap-3 text-sm text-white/60">
            <span>{photoNotice.text}</span>
            {photoNotice.offerRequest && (
              <button
                type="button"
                onClick={startRequest}
                disabled={consentBusy}
                className="font-semibold text-[#7C9BFF] hover:text-white disabled:opacity-50"
              >
                Send request
              </button>
            )}
          </div>
        )}
        {sendError && <p className="mb-2 text-center text-sm text-red-400">{sendError}</p>}
        {partnerKey?.error && (
          <p className="mb-2 text-center text-sm text-red-400">Couldn't load encryption keys. Reopen the chat to retry.</p>
        )}
        {match.ended ? (
          <p className="py-2 text-center text-sm text-white/40">This connection has ended.</p>
        ) : (
          <form onSubmit={handleSend} className="flex items-end gap-2">
            <button
              type="button"
              onClick={handlePhotoTap}
              disabled={consentBusy}
              aria-label="Share a photo"
              className={`rounded-xl p-2 hover:bg-white/10 disabled:opacity-40 ${
                match.mode === 'play' ? 'text-[#E03131]' : 'text-[#7C9BFF]'
              }`}
            >
              <CameraIcon className="h-6 w-6" />
            </button>
            <textarea
              rows={1}
              value={text}
              maxLength={MAX_MESSAGE_LENGTH}
              onChange={(e) => handleTextChange(e.target.value)}
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
        )}
      </div>

      {showFirstChat && humanPartner === partnerUid && (
        <FirstChatModal
          matchId={matchId}
          mode={match.mode === 'play' ? 'play' : 'spark'}
          onClose={() => setShowFirstChat(false)}
        />
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


      {showActions && (
        <ChatActionsSheet
          name={match.name}
          onReport={() => {
            setShowActions(false)
            setShowReport(true)
          }}
          onEnd={endConnection}
          onClose={() => setShowActions(false)}
          photo={
            !photosAvailable
              ? undefined
              : {
                  state:
                    consent?.status === 'accepted'
                      ? 'enabled'
                      : consent?.status === 'pending'
                        ? consent.requestedBy === uid
                          ? 'waiting'
                          : 'incoming'
                        : 'off',
                  // Theirs pending: accept it. Otherwise the 📷 flow (plan,
                  // keys, first-time explainer, then the request).
                  onAllow: () => {
                    setShowActions(false)
                    if (consent?.status === 'pending' && consent.requestedBy !== uid) {
                      void runConsent(() => respondToPhotoConsent(matchId, uid, true))
                    } else handlePhotoTap()
                  },
                  onRevoke: () => {
                    setShowActions(false)
                    void runConsent(() => pausePhotoSharing(matchId, uid))
                  },
                }
          }
        />
      )}

      {showPhotoBanner && (
        <PhotoConsentBanner
          onCancel={() => setShowPhotoBanner(false)}
          onProceed={() => {
            markPhotoBannerSeen(matchId)
            setShowPhotoBanner(false)
            void runConsent(() => requestPhotoConsent(matchId, uid))
          }}
        />
      )}

      {photoPaywall && <PaywallModal feature="photo_sharing" onClose={() => setPhotoPaywall(false)} />}

      {showPhotoPicker && (
        <PhotoPicker
          matchId={matchId}
          uid={uid}
          partnerUid={partnerUid}
          mode={match.mode === 'play' ? 'play' : 'spark'}
          onClose={() => setShowPhotoPicker(false)}
        />
      )}

      {showReport && (
        <ReviewModal matchId={matchId} partnerUid={partnerUid} name={match.name} onClose={() => setShowReport(false)} />
      )}

      {exitReview && (
        <ReviewModal
          matchId={matchId}
          partnerUid={partnerUid}
          name={match.name}
          onClose={() => {
            markReviewed(matchId)
            leave()
          }}
        />
      )}

      {showReview && (
        <ReviewModal matchId={matchId} partnerUid={partnerUid} name={match.name} onClose={() => setShowReview(false)} />
      )}
    </div>
  )
}
