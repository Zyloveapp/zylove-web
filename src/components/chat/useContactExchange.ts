import { useEffect, useMemo, useRef, useState } from 'react'
import {
  UNLOCK_MESSAGES,
  pendingCard,
  sendContactCard,
  setPendingCard,
  subscribeContactExchange,
  type ContactExchange,
} from '../../services/contactExchange'
import type { ChatMessage } from '../../services/chat'

// T&S Phase 3 — the chat's contact-exchange state: the server's state, how
// close the chat is to unlocking (both people need UNLOCK_MESSAGES real
// messages — the server checks again), and sending the card the person who
// asked chose, from this device, once the other person accepts.
// F-062: `uid` is this account (its device storage, its keys); `selfId` is
// you as the match names you — your Play ID in a Play chat.
export function useContactExchange({
  matchId,
  uid,
  selfId,
  partnerUid,
  partnerKey,
  messages,
}: {
  matchId: string
  uid: string
  selfId: string
  partnerUid: string
  partnerKey: string | null
  messages: ChatMessage[] | null
}) {
  const [state, setState] = useState<{ matchId: string; ce: ContactExchange | null } | null>(null)
  useEffect(() => subscribeContactExchange(matchId, (ce) => setState({ matchId, ce })), [matchId])
  const ce = state?.matchId === matchId ? state.ce : null

  const counts = useMemo(() => {
    const real = (messages ?? []).filter((m) => m.nonce !== 'system' && (m.messageType === 'text' || m.messageType === 'photo'))
    return { mine: real.filter((m) => m.senderId === selfId).length, theirs: real.filter((m) => m.senderId === partnerUid).length }
  }, [messages, selfId, partnerUid])
  const unlocked = counts.mine >= UNLOCK_MESSAGES && counts.theirs >= UNLOCK_MESSAGES

  const sending = useRef<string | null>(null)
  useEffect(() => {
    if (!ce || ce.status !== 'accepted' || ce.requestedBy !== selfId || !partnerKey || messages === null) return
    const attempt = `${matchId}:${ce.requestedAt}`
    const sent = messages.some((m) => m.messageType === 'contact_card' && m.senderId === selfId && (m.sentAt ?? Infinity) >= ce.requestedAt)
    const card = pendingCard(uid, matchId)
    if (sent) {
      if (card) setPendingCard(uid, matchId, null)
      return
    }
    if (!card || sending.current === attempt) return
    sending.current = attempt
    sendContactCard(matchId, uid, card, partnerKey).then(
      () => setPendingCard(uid, matchId, null),
      () => {
        sending.current = null
      },
    )
  }, [ce, messages, matchId, uid, selfId, partnerKey])

  // Accepted, but the card they chose isn't on this device (asked from
  // another one): the chat offers to send one from here.
  const needsCard =
    ce?.status === 'accepted' &&
    ce.requestedBy === selfId &&
    messages !== null &&
    !messages.some((m) => m.messageType === 'contact_card' && m.senderId === selfId && (m.sentAt ?? Infinity) >= ce.requestedAt) &&
    pendingCard(uid, matchId) === null

  return { ce, counts, unlocked, needsCard }
}
