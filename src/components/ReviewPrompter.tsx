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

type Pending = KnownMatch & { matchId: string }

// "Match ended" review trigger. A match ends when it's blocked or unmatched,
// or when its doc disappears — mobile's unmatch deletes it. Vanished matches
// are spotted by comparing against the matches this device saw last time.
// Each ended match is offered once (zylove_reviewed_{matchId}), and only
// with a real conversation behind it.
export default function ReviewPrompter() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const { pathname } = useLocation()
  const [queue, setQueue] = useState<{ uid: string; items: Pending[] }>({ uid: '', items: [] })

  useEffect(() => {
    if (!uid) return
    return subscribeAllMatches(
      uid,
      (matches) => {
        const known = loadKnownMatches(uid)
        const present = new Set(matches.map((m) => m.matchId))
        const eligible = (matchId: string, k: KnownMatch) => k.hadMessages && !isBotUid(k.partnerUid) && !reviewed(matchId)

        const vanished: Pending[] = Object.entries(known)
          .filter(([matchId, k]) => !present.has(matchId) && eligible(matchId, k))
          .map(([matchId, k]) => ({ ...k, matchId }))
        const blocked: Pending[] = matches
          .filter((m) => m.ended)
          .map((m) => ({ matchId: m.matchId, partnerUid: m.partnerUid, name: m.name, hadMessages: m.lastMessageAt > 0 }))
          .filter((p) => eligible(p.matchId, p))

        // Remember live matches, plus vanished ones not yet offered, so a
        // closed tab doesn't lose them.
        const next: Record<string, KnownMatch> = {}
        for (const m of matches) {
          if (!m.ended) next[m.matchId] = { partnerUid: m.partnerUid, name: m.name, hadMessages: m.lastMessageAt > 0 }
        }
        for (const p of vanished) next[p.matchId] = { partnerUid: p.partnerUid, name: p.name, hadMessages: p.hadMessages }
        saveKnownMatches(uid, next)

        setQueue({ uid, items: [...vanished, ...blocked] })
      },
      () => {},
    )
  }, [uid])

  // Never over a conversation: chats live on /matches and /chat/:id.
  const inConversation = pathname.startsWith('/matches') || pathname.startsWith('/chat')
  const current = queue.uid === uid ? queue.items[0] : undefined
  if (!current || inConversation) return null

  function close() {
    if (!current) return
    markReviewed(current.matchId)
    setQueue((q) => ({ ...q, items: q.items.filter((p) => p.matchId !== current.matchId) }))
  }

  return <ReviewModal key={current.matchId} matchId={current.matchId} partnerUid={current.partnerUid} name={current.name} onClose={close} />
}
