import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { subscribeAllMatches } from '../services/matches'
import {
  isBotUid,
  loadKnownMatches,
  markReviewed,
  reviewed,
  saveKnownMatches,
  type KnownMatch,
} from '../services/zyloveScore'
import ReviewModal from './chat/ReviewModal'
import { useExitReviewStore } from '../store/exitReviewStore'

type Pending = KnownMatch & { matchId: string; generation: number }

// Device memory of matches is keyed by match and generation, so a re-match
// (same id, new generation) leaves the earlier one to be offered for review.
const knownKey = (matchId: string, generation: number) => `${matchId}_${generation}`

// "Match ended" review trigger. A match ends when it's blocked or unmatched,
// when its doc disappears (mobile's unmatch deletes it), or when a re-match
// replaces it under the same id. Ended-and-gone matches are spotted by
// comparing against the matches this device saw last time. Each ended match
// generation is offered once (zylove_reviewed_{matchId}_{generation}), and
// only with a real conversation behind it.
export default function ReviewPrompter() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const { pathname } = useLocation()
  const [queue, setQueue] = useState<{ uid: string; items: Pending[] }>({ uid: '', items: [] })
  // Just ended from a chat (ChatView): shown at once, wherever they land.
  const exitReview = useExitReviewStore((s) => s.pending)
  const clearExitReview = useExitReviewStore((s) => s.clear)

  useEffect(() => {
    if (!uid) return
    return subscribeAllMatches(
      uid,
      (matches) => {
        // Entries saved before generations are keyed by bare matchId: the
        // key is the id and the generation is unknown (0).
        const known: Pending[] = Object.entries(loadKnownMatches(uid)).map(([key, k]) => ({
          ...k,
          matchId: k.matchId ?? key,
          generation: k.generation ?? 0,
        }))
        const present = new Set(matches.map((m) => knownKey(m.matchId, m.startedAt)))
        const presentIds = new Set(matches.map((m) => m.matchId))
        const eligible = (p: Pending) => p.hadMessages && !isBotUid(p.partnerUid) && !reviewed(p.matchId, p.generation)
        // Gone: its generation isn't live any more. An unknown-generation
        // entry is gone only when its match id is.
        const gone = (p: Pending) =>
          p.generation > 0 ? !present.has(knownKey(p.matchId, p.generation)) : !presentIds.has(p.matchId)

        const vanished = known.filter((p) => gone(p) && eligible(p))
        const blocked: Pending[] = matches
          .filter((m) => m.ended)
          .map((m) => ({
            matchId: m.matchId,
            generation: m.startedAt,
            partnerUid: m.partnerUid,
            name: m.name,
            hadMessages: m.lastMessageAt > 0,
          }))
          .filter(eligible)

        // Remember live matches, plus vanished ones not yet offered, so a
        // closed tab doesn't lose them.
        const next: Record<string, KnownMatch> = {}
        const remember = (p: Pending) => {
          next[knownKey(p.matchId, p.generation)] = {
            matchId: p.matchId,
            generation: p.generation,
            partnerUid: p.partnerUid,
            name: p.name,
            hadMessages: p.hadMessages,
          }
        }
        for (const m of matches) {
          if (!m.ended) {
            remember({
              matchId: m.matchId,
              generation: m.startedAt,
              partnerUid: m.partnerUid,
              name: m.name,
              hadMessages: m.lastMessageAt > 0,
            })
          }
        }
        for (const p of vanished) remember(p)
        saveKnownMatches(uid, next)

        setQueue({ uid, items: [...vanished, ...blocked] })
      },
      () => {},
    )
  }, [uid])

  if (exitReview) {
    return (
      <ReviewModal
        key={knownKey(exitReview.matchId, exitReview.generation)}
        matchId={exitReview.matchId}
        generation={exitReview.generation}
        partnerUid={exitReview.partnerUid}
        name={exitReview.name}
        onClose={() => {
          markReviewed(exitReview.matchId, exitReview.generation)
          clearExitReview()
        }}
      />
    )
  }

  // Never over a conversation: chats live on /matches and /chat/:id.
  const inConversation = pathname.startsWith('/matches') || pathname.startsWith('/chat')
  // Skips any reviewed since the list was built (e.g. the exit review).
  const current = queue.uid === uid ? queue.items.find((p) => !reviewed(p.matchId, p.generation)) : undefined
  if (!current || inConversation) return null

  function close() {
    if (!current) return
    markReviewed(current.matchId, current.generation)
    setQueue((q) => ({ ...q, items: q.items.filter((p) => p !== current) }))
  }

  return (
    <ReviewModal
      key={knownKey(current.matchId, current.generation)}
      matchId={current.matchId}
      generation={current.generation}
      partnerUid={current.partnerUid}
      name={current.name}
      onClose={close}
    />
  )
}
