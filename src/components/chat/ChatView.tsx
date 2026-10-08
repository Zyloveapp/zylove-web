import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import CuratedBadge from '../CuratedBadge'
import { useNavigate } from 'react-router-dom'
import {
  ENCRYPTION_KEY_MISSING,
  RECIPIENT_NO_KEY,
  rememberPartnerKey,
  MAX_MESSAGE_LENGTH,
  consentCode,
  markMessagesRead,
  sendMessage,
  subscribeMessages,
  type ChatMessage,
} from '../../services/chat'
import { decryptMessage } from '../../services/encryption'
import { chatPrivateKey, subscribeKeyState, subscribePartnerKey, type KeyState } from '../../services/keys'
import { KEY_BACKUP_EVENT } from '../KeyBackupGate'
import { markMatchRead, type MatchEntry } from '../../services/matches'
import {
  markMutualVibeCelebrated,
  markVibeCheckFired,
  mutualVibeCelebrated,
  shouldTriggerVibeCheck,
  subscribeMutualVibe,
  subscribeVibeCheckState,
  vibeModeOf,
  type VibeCheckState,
} from '../../services/vibeCheck'
import { clearTyping, setTyping, subscribeTyping } from '../../services/typing'
import {
  coldReviewShown,
  conversationCold,
  isBotUid,
  markColdReviewShown,
  reviewed,
} from '../../services/zyloveScore'
import { blockMatch, unmatch } from '../../services/safety'
import { useExitReviewStore } from '../../store/exitReviewStore'
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
import ReportModal from './ReportModal'
import VibeCheckModal from './VibeCheckModal'
import VibeCelebration, { CELEBRATION_MS } from './VibeCelebration'
import { firstChatSeen, firstChatSeenRemotely } from './firstChatSeen'
import { fetchPublicUserDoc } from '../../services/publicUserDoc'
import { openerHash } from '../../services/openerHash'
import { hasLink, looksLikeCode } from '../../services/scamRules'
import { useAuthStore } from '../../store/authStore'
import { IncomingSafety } from './ChatSafety'
import { ContactCardMessage, ContactNotice, ContactSheet } from './ContactExchange'
import { useContactExchange } from './useContactExchange'
import { useFrankChecks } from './useFrankChecks'
import { revealKf } from '../../services/franking'
import { openPhotoBytes } from '../../services/photos'
import type { EvidenceCandidate } from '../../services/evidence'
import { CONTACT_CODES, parseCard, requestContact, respondContact, revokeContact, saveDefaults, savedDefaults, sendContactCard, setPendingCard, UNLOCK_MESSAGES, type ContactCard, type ContactCode } from '../../services/contactExchange'
import { CONTACT_MASK, detectContact, maskContact } from '../../services/contactDetect'
import { LINKS_LATER, useCanSendLinks, useSenderTrust } from './useChatSafety'
import { usePlayIdentity } from '../matches/usePlayIdentity'
import { useDistanceMiles } from '../DistanceLabel'
import { friendlyError } from '../../services/errors'
import StoredImg from '../StoredImg'

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
// Shown once in place of every bubble that won't open: this device is locked
// (unlock with the chat PIN brings them back), or they were sent before a
// chat key was reset ("start fresh"), which can't be undone.
const KEY_RESET_NOTICE =
  "Some earlier messages can't be read on this device. If you've set a chat PIN, unlock your chats to read them."
// Own typing: write at most every 2s, clear after 3s idle. Partner's counts
// as typing while their typingAt is under 5s old.
const TYPING_WRITE_MS = 2000
const TYPING_IDLE_MS = 3000
const TYPING_FRESH_MS = 5000
const VIBE_CHECK_DELAY_MS = 1500
const NEARBY_MILES = 10
// The character count shows from here up to MAX_MESSAGE_LENGTH.
const COUNTER_FROM = 1800

// Touch keyboards: Enter adds a new line and the Send button sends.
// Desktop: Enter sends, Shift+Enter adds a new line.
function coarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export default function ChatView({ uid, match: entry, onBack }: ChatViewProps) {
  const { matchId, partnerUid } = entry
  // F-062: you and the partner as this match names you — Play IDs in a Play
  // chat (uid stays for this account's own things: its keys, its records).
  const me = entry.selfId
  // A curated profile: by the match (in Play the id doesn't say so).
  const partnerIsBot = entry.isBot || isBotUid(partnerUid)
  // A Play chat shows their Play name and photo — never the Spark ones an
  // older snapshot may hold (blank while loading, 'Someone' with no name).
  const playIdentity = usePlayIdentity(partnerUid, entry.mode === 'play')
  // Their Play profile can't be read (they don't have Play access right now,
  // Stage 2): a neutral "not available" state — the snapshot name, no photo,
  // no composer. The conversation is kept; it comes back with their access.
  const partnerUnavailable = playIdentity?.unavailable === true
  const match: MatchEntry =
    playIdentity === null
      ? entry
      : partnerUnavailable
        ? { ...entry, photoURL: null }
        : { ...entry, name: playIdentity?.name || (playIdentity ? 'Someone' : ''), photoURL: playIdentity?.photoURL ?? null }
  // The header says "Nearby" under NEARBY_MILES, and nothing otherwise.
  const miles = useDistanceMiles(partnerUid)
  const nearby = miles !== null && miles < NEARBY_MILES
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [online, setOnline] = useState(isOnline)
  const [touchKeyboard] = useState(coarsePointer)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // The first-chat card promises "You're talking to a real human", so it's
  // never shown for demonstration profiles — known by uid prefix right away,
  // or by isBot on their user doc (checked before the card appears).
  const [showFirstChat, setShowFirstChat] = useState(() => !firstChatSeen(matchId) && !partnerIsBot)
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
  // T&S Phase 2: "Report" on a scam banner opens the report with Scam chosen.
  const [reportPreset, setReportPreset] = useState<string[]>([])
  // A message that looks like a one-time code waits for a second Send.
  const [confirmCode, setConfirmCode] = useState<string | null>(null)
  const senderTrust = useSenderTrust(partnerUid, partnerIsBot)
  // T&S Phase 3: Share contact.
  const [contactSheet, setContactSheet] = useState<'share' | 'shareBack' | 'resend' | null>(null)
  const [contactBusy, setContactBusy] = useState(false)
  const [contactError, setContactError] = useState<string | null>(null)
  const [contactNotice, setContactNotice] = useState<{ text: string; cancel?: boolean } | null>(null)
  const canSendLinks = useCanSendLinks(uid, useAuthStore((s) => s.user?.metadata.creationTime))
  const offerExitReview = useExitReviewStore((s) => s.offer)
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
      me,
      match.startedAt,
      (messages) => {
        setLoaded({ matchId, messages, error: false })
        const unreadFromPartner = messages.filter((m) => m.senderId !== me && m.status !== 'read').map((m) => m.id)
        if (unreadFromPartner.length > 0) {
          markMessagesRead(matchId, unreadFromPartner).catch(() => {})
          markMatchRead(uid, matchId).catch(() => {})
        }
      },
      () => setLoaded({ matchId, messages: [], error: true }),
    )
  }, [matchId, uid, me, match.startedAt])

  useEffect(
    () => subscribePhotoConsent(matchId, (consent) => setConsentState({ matchId, consent })),
    [matchId],
  )

  useEffect(() => {
    if (partnerIsBot) return
    // F-062: a Play partner is known by Play ID only (the match's isBot says
    // whether it's curated).
    if (entry.mode === 'play') {
      setHumanPartner(partnerUid)
      return
    }
    let cancelled = false
    fetchPublicUserDoc(partnerUid).then((partner) => {
      if (cancelled) return
      if (partner?.isBot === true) setShowFirstChat(false)
      else setHumanPartner(partnerUid)
    })
    return () => {
      cancelled = true
    }
  }, [partnerUid, partnerIsBot, entry.mode])

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

  const [keyChangedFor, setKeyChangedFor] = useState<string | null>(null)
  useEffect(
    () =>
      subscribePartnerKey(
        partnerUid,
        (key) => {
          setPartnerKeyState({ partnerUid, key, error: false })
          // Stage B: the key this device first saw for them is remembered;
          // a different one later (new device, PIN reset — or a swapped key)
          // is pointed out.
          if (key && rememberPartnerKey(uid, partnerUid, key) === 'changed') setKeyChangedFor(partnerUid)
        },
        () => setPartnerKeyState({ partnerUid, key: '', error: true }),
      ),
    [partnerUid, uid],
  )

  // This device's chat key status; a PIN unlock or reset (KeyBackupGate)
  // bumps it, and the private key is re-read.
  const [deviceKey, setDeviceKey] = useState<KeyState | null>(null)
  useEffect(() => subscribeKeyState(uid, setDeviceKey), [uid])
  const deviceKeyStatus = deviceKey?.status ?? 'unknown'
  useEffect(() => {
    let cancelled = false
    // A Play chat opens with the Play key (F-062).
    chatPrivateKey(uid, matchId).then((key) => {
      if (!cancelled) setMyKeyState({ uid, key })
    })
    return () => {
      cancelled = true
    }
  }, [uid, matchId, deviceKeyStatus])
  const deviceLocked = deviceKeyStatus === 'needs_restore' || deviceKeyStatus === 'locked' || deviceKeyStatus === 'check_failed'

  const partnerKey = partnerKeyState?.partnerUid === partnerUid ? partnerKeyState : null
  const myPrivateKey = myKeyState?.uid === uid ? myKeyState.key : undefined
  const keysLoaded = partnerKey !== null && myPrivateKey !== undefined
  const rawMessages = loaded?.matchId === matchId ? loaded.messages : null

  // Both sides decrypt with (partner public key, own private key); nacl.box's
  // shared secret is the same in either direction.
  const messages = useMemo(() => {
    if (rawMessages === null || !keysLoaded) return null
    return rawMessages.map((m) => {
      const text = decryptMessage(m.ciphertext, m.nonce, partnerKey.key, myPrivateKey ?? '')
      return {
        ...m,
        text: text ?? UNDECRYPTABLE,
        undecryptable: text === null && m.messageType === 'text',
        // Sent unencrypted (bots, or older apps): marked as such (Stage B).
        plaintext: m.messageType === 'text' && (m.nonce === 'stub' || m.nonce === 'stub-nonce'),
      }
    })
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

  // This user's vibe-check state (matches/{id}.vibeCheckState_{uid}).
  const [vibeState, setVibeState] = useState<{ matchId: string; state: VibeCheckState } | null>(null)
  useEffect(() => subscribeVibeCheckState(matchId, me, (state) => setVibeState({ matchId, state })), [matchId, me])
  const vibe = vibeState?.matchId === matchId ? vibeState.state : null
  const vibeMode = vibeModeOf(match.mode)

  useEffect(() => {
    // Waits for the state, so a check already shown elsewhere doesn't repeat.
    if (vibeCheckFired.current || showFirstChat || !vibe) return
    const senders = conversation.map((m) => m.senderId)
    if (!shouldTriggerVibeCheck(senders, me, vibe, vibeMode)) return
    vibeCheckFired.current = true
    void markVibeCheckFired(matchId, me, senders.length)
    // Kept in a ref so a message arriving during the delay doesn't cancel it.
    vibeCheckTimer.current = setTimeout(() => setShowVibeCheck(true), VIBE_CHECK_DELAY_MS)
  }, [conversation, showFirstChat, me, matchId, vibe, vibeMode])

  useEffect(() => () => clearTimeout(vibeCheckTimer.current), [])

  // Review prompt, "gone cold" trigger: once per match, on opening a chat
  // that's been quiet 30+ days after 10+ messages. Never while a conversation
  // is active; ended matches are handled app-wide by ReviewPrompter.
  useEffect(() => {
    if (reviewChecked.current || messages === null || showFirstChat) return
    reviewChecked.current = true
    // Never stack on a vibe check fired by this open.
    if (vibeCheckFired.current || partnerIsBot || reviewed(matchId, match.startedAt) || coldReviewShown(matchId, match.startedAt)) return
    if (!conversationCold(conversation[conversation.length - 1]?.sentAt ?? null, conversation.length)) return
    markColdReviewShown(matchId, match.startedAt)
    setShowReview(true)
  }, [messages, showFirstChat, conversation, partnerUid, matchId, match.startedAt])

  useEffect(() => {
    const update = () => setOnline(isOnline())
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // The input grows with its text up to max-h-32 (then scrolls), and shrinks
  // back once the text is sent.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [text])

  // Leaving the chat (or switching matches) clears our typing status.
  useEffect(
    () => () => {
      clearTimeout(typingIdleTimer.current)
      lastTypingWrite.current = 0
      clearTyping(matchId, me).catch(() => {})
    },
    [matchId, me],
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
    clearTyping(matchId, me).catch(() => {})
  }

  function handleTextChange(value: string) {
    setText(value)
    if (!value.trim()) return stopTyping()
    const t = Date.now()
    if (t - lastTypingWrite.current >= TYPING_WRITE_MS) {
      lastTypingWrite.current = t
      setTyping(matchId, me).catch(() => {})
    }
    clearTimeout(typingIdleTimer.current)
    typingIdleTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS)
  }

  const trimmed = text.trim()
  const tooLong = text.length > MAX_MESSAGE_LENGTH
  const ownBubble = match.mode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
  // Never fall back to plaintext just because the partner's key failed to load.
  const canSend = partnerKey !== null && !partnerKey.error
  const contact = useContactExchange({
    matchId,
    uid,
    selfId: me,
    partnerUid,
    partnerKey: partnerKey && !partnerKey.error && partnerKey.key ? partnerKey.key : null,
    messages: rawMessages,
  })
  // T&S Phase 4: this sender's next message number (franking), the messages
  // whose commitment didn't check out (refused), and what a report may attach.
  const mySeq = (rawMessages ?? []).filter((m) => m.senderId === me && m.nonce !== 'system' && (m.messageType === 'text' || m.messageType === 'photo')).length + 1
  const partnerKeyValue = partnerKey && !partnerKey.error && partnerKey.key ? partnerKey.key : null
  const frankBad = useFrankChecks(messages, matchId, partnerKeyValue, myPrivateKey)
  const evidenceCandidates = useMemo<EvidenceCandidate[]>(
    () =>
      (messages ?? [])
        .filter((m) => m.nonce !== 'system' && !m.undecryptable && (m.messageType === 'text' || (m.messageType === 'photo' && m.photo)))
        .map((m) => ({
          id: m.id,
          from: m.senderId === me ? ('me' as const) : ('them' as const),
          type: m.messageType === 'photo' ? ('photo' as const) : ('text' as const),
          text: m.messageType === 'photo' ? '📷 Photo' : m.text,
          sentAt: m.sentAt,
          revealKf: () => (m.frank && partnerKeyValue && myPrivateKey ? revealKf(m.frank, partnerKeyValue, myPrivateKey) : null),
          ...(m.photo && partnerKeyValue ? { photoBytes: () => openPhotoBytes(m.photo!, m.senderId === me, uid, partnerKeyValue) } : {}),
        })),
    [messages, uid, me, partnerKeyValue, myPrivateKey],
  )
  const latestContactNoticeId = useMemo(
    () => [...(messages ?? [])].reverse().find((m) => m.messageType === 'contact_request' && m.nonce === 'system')?.id ?? null,
    [messages],
  )

  function contactFailed(err: unknown) {
    setContactError(friendlyError(err, "Couldn't do that. Try again."))
  }

  function handleContactTap() {
    setContactError(null)
    const ce = contact.ce
    if (partnerIsBot) return setContactNotice({ text: "Contact details can't be shared with a curated profile." })
    if (contact.needsCard) return setContactSheet('resend')
    if (ce?.status === 'pending') {
      return setContactNotice(
        ce.requestedBy === me ? { text: `Waiting for ${match.name} to answer your contact request.`, cancel: true } : { text: `${match.name} asked to share contact details — answer above.` },
      )
    }
    if (ce?.status === 'accepted') return setContactNotice({ text: 'Contact details are shared in this chat. Use "Take back" on a card to remove them.' })
    if (!contact.unlocked) {
      return setContactNotice({
        text: `Share contact unlocks once you've both sent ${UNLOCK_MESSAGES} messages (you ${Math.min(contact.counts.mine, UNLOCK_MESSAGES)}/${UNLOCK_MESSAGES} · ${match.name} ${Math.min(contact.counts.theirs, UNLOCK_MESSAGES)}/${UNLOCK_MESSAGES}).`,
      })
    }
    setContactNotice(null)
    setContactSheet('share')
  }

  async function confirmContact(card: ContactCard) {
    if (!contactSheet) return
    setContactBusy(true)
    setContactError(null)
    saveDefaults(uid, card)
    try {
      if (contactSheet === 'share') {
        // Kept on this device until they accept; it goes out then.
        setPendingCard(uid, matchId, card)
        await requestContact(matchId).catch((err: unknown) => {
          setPendingCard(uid, matchId, null)
          throw err
        })
      } else {
        if (contactSheet === 'shareBack') await respondContact(matchId, true, true)
        await sendContactCard(matchId, uid, card, partnerKey?.key ?? '')
      }
      setContactSheet(null)
    } catch (err) {
      contactFailed(err)
    } finally {
      setContactBusy(false)
    }
  }

  async function contactAction(action: () => Promise<unknown>) {
    setContactBusy(true)
    setContactError(null)
    try {
      await action()
      setContactNotice(null)
    } catch (err) {
      contactFailed(err)
    } finally {
      setContactBusy(false)
    }
  }

  async function handleSend(e?: FormEvent) {
    e?.preventDefault()
    if (!trimmed || tooLong || sending || !canSend) return
    // T&S Phase 3 (on this device): contact details only through Share contact.
    if (detectContact(trimmed).length > 0) {
      setSendError(
        partnerIsBot
          ? "Phone numbers, handles and emails can't be sent in chat."
          : `Phone numbers, handles and emails can't be sent in chat — use Share contact 🪪 instead${contact.unlocked ? '' : ` (it unlocks once you've both sent ${UNLOCK_MESSAGES} messages)`}.`,
      )
      return
    }
    // T&S Phase 2 (on this device only): no links in an account's first
    // 48 hours, and a code-like message is sent only on a second Send.
    if (!partnerIsBot && hasLink(trimmed) && !canSendLinks) {
      setSendError(LINKS_LATER)
      return
    }
    if (!partnerIsBot && looksLikeCode(trimmed) && confirmCode !== trimmed) {
      setConfirmCode(trimmed)
      setSendError(null)
      return
    }
    setConfirmCode(null)
    const sent = trimmed
    setSending(true)
    setSendError(null)
    stopTyping()
    // Cleared at once — the message shows as "Sending…" until the server has
    // it — so anything typed meanwhile is kept. If it doesn't go through, the
    // text comes back (ahead of anything typed since) to try again.
    setText('')
    const restore = (err: unknown) => {
      setText((cur) => (cur.trim() ? `${sent}\n${cur}` : sent))
      setSendError(
        err instanceof Error && err.message === ENCRYPTION_KEY_MISSING
          ? 'To send messages here, unlock your chats with your chat PIN (Settings → Chat PIN).'
          : err instanceof Error && err.message === RECIPIENT_NO_KEY
            ? `${match.name} hasn't set up encrypted chat yet, so this can't be sent. You can message them once they open Zylove on the web.`
            : friendlyError(err, "Couldn't send. Try again."),
      )
    }
    let delivered: Promise<void>
    try {
      // My first message in this chat: its on-device hash goes along (duplicate-opener check).
      const firstFromMe = !(rawMessages ?? []).some((m) => m.senderId === me && m.nonce !== 'system')
      const fh = firstFromMe ? await openerHash(sent, match.name).catch(() => null) : null
      delivered = (await sendMessage(matchId, uid, sent, partnerKey.key, partnerUid, fh, mySeq, partnerIsBot)).delivered
    } catch (err) {
      restore(err)
      return
    } finally {
      setSending(false)
    }
    delivered.catch(restore)
  }

  // ── Photo sharing ──────────────────────────────────────────────────────────
  const consent = consentState?.matchId === matchId ? consentState.consent : null
  // The camera shows in every live chat; photos only go to real people.
  // Photos are always encrypted, so sending also needs the partner's real
  // key — mobile-only users have a stubbed one until they sign in on the
  // web — and tapping explains that.
  const botChat = partnerIsBot
  const photosAvailable = !match.ended && !botChat
  const partnerCanReceivePhotos = partnerKey !== null && partnerKey.key !== ''
  const latestRequestId = useMemo(
    () => [...(messages ?? [])].reverse().find((m) => consentCode(m) === 'photo_consent_request')?.id ?? null,
    [messages],
  )
  // The newest consent message is the request itself (nothing answered it
  // yet). Read from the live messages, so the request can be answered the
  // moment it arrives — not only once the match doc's status catches up.
  const requestOpenInChat = useMemo(() => {
    const last = [...(messages ?? [])].reverse().find((m) => consentCode(m) !== null)
    return last !== undefined && consentCode(last) === 'photo_consent_request'
  }, [messages])
  const requestPending =
    consent?.status === 'pending' || (requestOpenInChat && (consent === null || consent.status !== 'accepted'))

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
    if (photoBannerSeen(matchId)) void runConsent(() => requestPhotoConsent(matchId, me))
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
            : `${match.name} hasn't set up photo sharing yet.`,
        offerRequest: false,
      })
    }
    switch (consent?.status) {
      case 'accepted':
        return setShowPhotoPicker(true)
      case 'pending':
        return setPhotoNotice({
          text:
            consent.requestedBy === me
              ? `Waiting for ${match.name} to accept`
              : `${match.name} asked to share photos — answer above.`,
          offerRequest: false,
        })
      case 'declined':
        return setPhotoNotice({
          text:
            consent.requestedBy === me
              ? `${match.name} declined photo sharing. Send a new request?`
              : 'You declined photo sharing. Send a request?',
          offerRequest: true,
        })
      case 'paused':
        return setPhotoNotice({ text: 'Photo sharing is paused. Send a new request?', offerRequest: true })
      default:
        return startRequest()
    }
  }

  // onBack already leaves (closes the pane, or navigates); navigating as
  // well would add a second history entry.
  function leave() {
    if (onBack) onBack()
    else navigate('/matches')
  }

  async function endConnection(action: Exclude<ChatAction, 'report'>) {
    if (action === 'block') await blockMatch(matchId, partnerUid)
    else await unmatch(matchId)
    setShowActions(false)
    // Same rules as the app-wide prompt: a real person, a real conversation,
    // not already reviewed. Offered app-wide: unmatching deletes the match,
    // which closes this chat.
    if (!partnerIsBot && conversation.length > 0 && !reviewed(matchId, match.startedAt)) {
      offerExitReview({ matchId, generation: match.startedAt, partnerUid, name: match.name, mode: match.mode })
    }
    leave()
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !touchKeyboard && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void handleSend()
    }
  }

  // Mutual "Loving it" (matches/{id}.mutualVibeAt, stamped server-side):
  // celebrate once per stamp in this browser — live if they're here, or on
  // opening the chat later — then leave a system line where it happened.
  const [mutualVibeAt, setMutualVibeAt] = useState<number | null>(null)
  const [celebrating, setCelebrating] = useState(false)
  useEffect(() => subscribeMutualVibe(matchId, me, partnerUid, setMutualVibeAt), [matchId, me, partnerUid])
  useEffect(() => {
    if (mutualVibeAt === null || mutualVibeCelebrated(matchId, uid, mutualVibeAt)) return
    markMutualVibeCelebrated(matchId, uid, mutualVibeAt)
    setCelebrating(true)
    const done = setTimeout(() => setCelebrating(false), CELEBRATION_MS)
    return () => clearTimeout(done)
  }, [matchId, uid, mutualVibeAt])

  const vibeLine =
    mutualVibeAt !== null && !celebrating ? (
      <p key="mutual-vibe" className={`text-center text-xs font-medium ${match.mode === 'play' ? 'text-[#FF8A80]' : 'text-[#9DB4FF]'}`}>
        {match.mode === 'play' ? '🔥 The vibe is mutual.' : "✦ You're both feeling it."}
      </p>
    ) : null
  // Before the first message sent after the moment; -1 = after them all.
  const vibeLineIndex =
    mutualVibeAt === null || !messages ? -1 : messages.findIndex((m) => m.sentAt !== null && m.sentAt > mutualVibeAt)

  // Undecryptable messages collapse into one notice, at the first of them.
  const firstUndecryptableId = messages?.find((m) => m.undecryptable)?.id ?? null
  // "Read" shows only under the newest of your messages they've read.
  const lastReadOwnId = useMemo(
    () =>
      [...(messages ?? [])]
        .reverse()
        .find((m) => m.senderId === me && m.status === 'read' && m.nonce !== 'system' && m.messageType === 'text')?.id ??
      null,
    [messages, me],
  )

  function renderMessage(m: ChatMessage & { text: string; undecryptable: boolean; plaintext: boolean }) {
              if (m.undecryptable) {
                return m.id === firstUndecryptableId ? (
                  <p key={m.id} className="mx-auto max-w-xs text-center text-xs italic text-white/40">
                    🔒 {KEY_RESET_NOTICE}
                  </p>
                ) : null
              }
              const code = consentCode(m)
              if (code) {
                return (
                  <PhotoConsentRequest
                    key={m.id}
                    mode={match.mode}
                    code={code}
                    isMine={m.senderId === me}
                    partnerName={match.name}
                    live={m.id === latestRequestId && requestPending}
                    busy={consentBusy}
                    onRespond={(accept) => void runConsent(() => respondToPhotoConsent(matchId, me, accept))}
                  />
                )
              }
              // T&S Phase 3: contact-exchange notices and cards.
              if (m.messageType === 'contact_request' && m.nonce === 'system' && (CONTACT_CODES as readonly string[]).includes(m.ciphertext)) {
                return (
                  <ContactNotice
                    key={m.id}
                    code={m.ciphertext as ContactCode}
                    isMine={m.senderId === me}
                    partnerName={match.name}
                    live={m.id === latestContactNoticeId && contact.ce?.status === 'pending'}
                    busy={contactBusy}
                    onReceiveOnly={() => void contactAction(() => respondContact(matchId, true, false))}
                    onShareBack={() => {
                      setContactError(null)
                      setContactSheet('shareBack')
                    }}
                    onDecline={() => void contactAction(() => respondContact(matchId, false))}
                  />
                )
              }
              if (m.messageType === 'contact_card') {
                const own = m.senderId === me
                return (
                  <div key={m.id} className={`flex flex-col ${own ? 'items-end' : 'items-start'}`}>
                    <ContactCardMessage
                      card={m.nonce === 'revoked' || !m.ciphertext ? null : parseCard(m.text)}
                      removed={m.nonce === 'revoked' || !m.ciphertext || contact.ce?.status === 'revoked'}
                      isMine={own}
                      partnerName={match.name}
                      onTakeBack={contact.ce?.status === 'accepted' ? () => void contactAction(() => revokeContact(matchId)) : null}
                    />
                    <span className="mt-1 text-xs text-white/30">{messageTime(m.sentAt)}</span>
                  </div>
                )
              }
              if (m.messageType === 'photo' && m.photo) {
                const own = m.senderId === me
                return (
                  <div key={m.id} className={`flex flex-col ${own ? 'items-end' : 'items-start'}`}>
                    <PhotoMessage
                      matchId={matchId}
                      messageId={m.id}
                      photo={m.photo}
                      isMine={own}
                      uid={uid}
                      partnerPublicKey={partnerKey?.key ?? ''}
                      mode={match.mode === 'play' ? 'play' : 'spark'}
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
              const own = m.senderId === me
              // T&S Phase 4: its franking commitment didn't check out — refused.
              if (frankBad.has(m.id)) {
                return (
                  <p key={m.id} className={`max-w-xs text-xs italic text-amber-200/70 ${own ? 'ml-auto text-right' : ''}`}>
                    ⚠️ This message couldn't be verified, so it isn't shown.
                  </p>
                )
              }
              // T&S Phase 3: contact details that slipped through are masked here.
              const masked = !own && m.messageType === 'text' && detectContact(m.text).length > 0
              const body =
                m.messageType === 'photo' ? "📷 Photo — can't be shown here" : masked ? maskContact(m.text) : m.text
              const safety =
                !own && !botChat && m.messageType === 'text' ? (
                  <IncomingSafety
                    text={m.text}
                    sentAt={m.sentAt}
                    sender={senderTrust}
                    onReport={() => {
                      setReportPreset(['scam'])
                      setShowReport(true)
                    }}
                  />
                ) : null
              return (
                <div key={m.id} className={`flex flex-col ${own ? 'items-end' : 'items-start'}`}>
                  <div
                    className={`max-w-[75%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 ${
                      own ? `${ownBubble} rounded-br-sm text-white` : 'rounded-bl-sm bg-white/10 text-white/90'
                    }`}
                  >
                    {body}
                  </div>
                  {masked && (
                    <p className="mt-1 max-w-[75%] text-xs text-white/40">
                      {CONTACT_MASK} Contact details are hidden in chat — use Share contact 🪪 to swap them safely.
                    </p>
                  )}
                  {safety}
                  <span className="mt-1 text-xs text-white/30">
                    {messageTime(m.sentAt)}
                    {m.id === lastReadOwnId && ' · Read'}
                    {m.plaintext && !botChat && ' · Not encrypted'}
                  </span>
                </div>
              )
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
            <StoredImg src={match.photoURL} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/10 font-semibold text-white/70">
              {match.name.charAt(0).toUpperCase()}
            </span>
          )}
          {/* Name, Age · Nearby */}
          <span className="min-w-0 truncate font-semibold">
            {match.name}
            {match.age !== null && <span className="font-normal text-white/50">, {match.age}</span>}
            {nearby && <span className="font-normal text-white/50"> · Nearby</span>}
          </span>
          <CuratedBadge uid={partnerUid} curated={partnerIsBot} />
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
      {botChat && (
        <p className="shrink-0 border-b border-white/10 bg-white/[0.04] px-4 py-2 text-center text-xs text-white/50 lg:px-6">
          {match.name} is a Zylove curated profile, here while your city's community is being built — not a real member. Curated
          profiles are removed from your city once its founding circle is full.
        </p>
      )}
      {keyChangedFor === partnerUid && (
        <div className="flex shrink-0 items-start gap-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-200 lg:px-6">
          <span className="flex-1">
            🔑 {match.name}'s chat key changed — usually a new device or a chat PIN reset. Messages are still encrypted. If you didn't expect
            this, check with them another way.
          </span>
          <button type="button" onClick={() => setKeyChangedFor(null)} className="text-amber-200/70 hover:text-white" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
      {celebrating && <VibeCelebration mode={match.mode === 'play' ? 'play' : 'spark'} />}
      <div className="h-full overflow-y-auto overscroll-contain px-4 py-4 lg:px-6">
        <div className="flex min-h-full flex-col justify-end gap-3">
          {messages === null ? (
            <div className="flex justify-center py-10">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </div>
          ) : loaded?.error ? (
            <p className="py-10 text-center text-sm text-white/40">Couldn't load messages.</p>
          ) : messages.length === 0 && !match.ended ? (
            <div className="m-auto max-w-xs py-10 text-center">
              <p className="text-lg font-semibold">
                Say hi to {match.name} {match.mode === 'play' ? '🔥' : '✦'}
              </p>
              <p className="mt-1 text-sm text-white/50">
                {match.mode === 'play'
                  ? "You've matched — someone has to make the first move."
                  : "You're linked. A simple hello is a great place to start."}
              </p>
            </div>
          ) : (
            messages.map((m, i) => {
              const el = renderMessage(m)
              return i === vibeLineIndex ? (
                <Fragment key={m.id}>
                  {vibeLine}
                  {el}
                </Fragment>
              ) : (
                el
              )
            })
          )}
          {messages !== null && !loaded?.error && vibeLineIndex === -1 && vibeLine}
          <TypingIndicator visible={showTyping} mode={match.mode} />
          <div ref={bottomRef} />
        </div>
      </div>
      </div>

      <div className="shrink-0 border-t border-white/10 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] lg:px-6">
        <ConversationNudge
          matchId={matchId}
          partnerUid={partnerUid}
          mode={match.mode === 'play' ? 'play' : 'spark'}
          messages={conversation}
          suppressed={showFirstChat || showVibeCheck || showReview || showReport || showPhotoPicker || showPhotoBanner}
          onPick={setText}
        />
        {contactNotice && (
          <div className="mb-2 flex items-center justify-center gap-3 text-center text-sm text-white/60">
            <span>🪪 {contactNotice.text}</span>
            {contactNotice.cancel && (
              <button type="button" onClick={() => void contactAction(() => revokeContact(matchId))} disabled={contactBusy} className="font-semibold text-[#7C9BFF] hover:text-white disabled:opacity-50">
                Cancel request
              </button>
            )}
          </div>
        )}
        {contactError && !contactSheet && <p className="mb-2 text-center text-sm text-red-400">{contactError}</p>}
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
        {confirmCode !== null && confirmCode === trimmed && (
          <p role="alert" className="mb-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-center text-sm text-red-200">
            🛡 This looks like a verification code. Never share codes — anyone asking for one is trying to get into an account. Tap
            Send again only if you're sure.
          </p>
        )}
        {!online && !match.ended && (
          <p className="mb-2 text-center text-sm text-amber-200/80" role="status">
            You're offline. Messages you send will go out when you reconnect — keep this tab open.
          </p>
        )}
        {deviceLocked && !match.ended && (
          <p className="mb-2 text-center text-sm text-amber-200/90" role="status">
            Your chats are locked on this device.{' '}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent(KEY_BACKUP_EVENT, { detail: 'unlock' }))}
              className="font-semibold underline hover:text-white"
            >
              Unlock with your chat PIN
            </button>
          </p>
        )}
        {partnerKey?.error && (
          <p className="mb-2 text-center text-sm text-red-400">Couldn't load encryption keys. Reopen the chat to retry.</p>
        )}
        {match.ended ? (
          <p className="py-2 text-center text-sm text-white/40">
            This connection has ended.
            {match.preservedUntil !== null &&
              ` You reported it, so this chat stays here, read-only and still encrypted, until ${new Date(match.preservedUntil).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.`}
          </p>
        ) : partnerUnavailable ? (
          <p className="py-2 text-center text-sm text-white/40">This connection isn't available right now.</p>
        ) : (
          <>
            {text.length >= COUNTER_FROM && (
              <p id="chat-char-count" className={`mb-1 text-right text-xs ${tooLong ? 'text-red-400' : 'text-white/40'}`}>
                {text.length}/{MAX_MESSAGE_LENGTH}
              </p>
            )}
            <form onSubmit={handleSend} className="flex items-end gap-2">
              <button
                type="button"
                onClick={handlePhotoTap}
                disabled={consentBusy}
                aria-label="Share a photo"
                className={`rounded-xl p-2 hover:bg-white/10 disabled:opacity-40 ${
                  // Play: red. Spark: neutral grey.
                  match.mode === 'play' ? 'text-[#E03131]' : 'text-white/50 hover:text-white/80'
                }`}
              >
                <CameraIcon className="h-6 w-6" />
              </button>
              <button
                type="button"
                onClick={handleContactTap}
                disabled={contactBusy}
                aria-label="Share contact"
                title={contact.unlocked ? 'Share contact' : `Unlocks once you've both sent ${UNLOCK_MESSAGES} messages`}
                className={`rounded-xl p-2 text-xl leading-none hover:bg-white/10 disabled:opacity-40 ${contact.unlocked ? '' : 'opacity-50'}`}
              >
                🪪
              </button>
              <textarea
                ref={inputRef}
                rows={1}
                value={text}
                maxLength={MAX_MESSAGE_LENGTH}
                onChange={(e) => handleTextChange(e.target.value)}
                onKeyDown={handleKeyDown}
                enterKeyHint={touchKeyboard ? 'enter' : 'send'}
                placeholder={`Message ${match.name}…`}
                aria-describedby={text.length >= COUNTER_FROM ? 'chat-char-count' : undefined}
                className="max-h-32 min-w-0 flex-1 resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!trimmed || tooLong || sending || !canSend}
                className={`rounded-xl px-5 py-2.5 font-medium text-white transition-opacity disabled:opacity-30 ${ownBubble}`}
              >
                Send
              </button>
            </form>
          </>
        )}
      </div>

      {/* Waits for the partner's key: the encryption promise depends on it. */}
      {showFirstChat && humanPartner === partnerUid && partnerKey !== null && !partnerKey.error && (
        <FirstChatModal
          matchId={matchId}
          mode={match.mode === 'play' ? 'play' : 'spark'}
          name={match.name}
          // Same test sendMessage uses: with no real key on their side,
          // messages go as plaintext (nonce 'stub').
          encrypted={partnerKey.key !== ''}
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
          mode={match.mode === 'play' ? 'play' : 'spark'}
        />
      )}


      {showActions && (
        <ChatActionsSheet
          name={match.name}
          // Real members only: curated profiles (by uid, or isBot on their
          // doc — humanPartner is set once that's checked) can't be reported.
          onReport={
            humanPartner === partnerUid
              ? () => {
                  setShowActions(false)
                  setReportPreset([])
                  setShowReport(true)
                }
              : undefined
          }
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
                        ? consent.requestedBy === me
                          ? 'waiting'
                          : 'incoming'
                        : 'off',
                  // Theirs pending: accept it. Otherwise the 📷 flow (plan,
                  // keys, first-time explainer, then the request).
                  onAllow: () => {
                    setShowActions(false)
                    if (consent?.status === 'pending' && consent.requestedBy !== me) {
                      void runConsent(() => respondToPhotoConsent(matchId, me, true))
                    } else handlePhotoTap()
                  },
                  onRevoke: () => {
                    setShowActions(false)
                    void runConsent(() => pausePhotoSharing(matchId, me))
                  },
                }
          }
        />
      )}

      {showPhotoBanner && (
        <PhotoConsentBanner
          mode={match.mode}
          onCancel={() => setShowPhotoBanner(false)}
          onProceed={() => {
            markPhotoBannerSeen(matchId)
            setShowPhotoBanner(false)
            void runConsent(() => requestPhotoConsent(matchId, me))
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
          seq={mySeq}
          onClose={() => setShowPhotoPicker(false)}
        />
      )}

      {showReport && (
        <ReportModal
          mode={match.mode}
          matchId={matchId}
          generation={match.startedAt}
          partnerUid={partnerUid}
          name={match.name}
          initialCategories={reportPreset}
          evidence={evidenceCandidates}
          onClose={() => setShowReport(false)}
        />
      )}

      {contactSheet && (
        <ContactSheet
          title={contactSheet === 'share' ? `Share contact with ${match.name}` : contactSheet === 'shareBack' ? `Share yours back with ${match.name}` : `Send your card to ${match.name}`}
          intro={
            contactSheet === 'share'
              ? `Pick what goes on your card. ${match.name} chooses whether to accept; your card is only sent if they do.`
              : 'Pick what goes on your card. It is end-to-end encrypted — Zylove can’t read it.'
          }
          initial={savedDefaults(uid)}
          confirmLabel={contactSheet === 'share' ? 'Send request' : contactSheet === 'shareBack' ? 'Accept and share' : 'Send card'}
          busy={contactBusy}
          error={contactError}
          onConfirm={(card) => void confirmContact(card)}
          onClose={() => setContactSheet(null)}
        />
      )}

      {showReview && (
        <ReviewModal mode={match.mode} matchId={matchId} generation={match.startedAt} partnerUid={partnerUid} name={match.name} onClose={() => setShowReview(false)} />
      )}
    </div>
  )
}
