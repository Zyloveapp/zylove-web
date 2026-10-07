import { useEffect, useState } from 'react'
import { checkFrank } from '../../services/franking'
import type { ChatMessage } from '../../services/chat'

// T&S Phase 4 — the recipient's half of franking: every decrypted text
// message that carries a commitment is checked on this device; a mismatch
// means the message isn't what was committed to, and it's refused (hidden).
// Returns the ids that failed.
export function useFrankChecks(
  messages: (ChatMessage & { text: string; undecryptable: boolean })[] | null,
  matchId: string,
  partnerPublicKey: string | null,
  myPrivateKey: string | null | undefined,
): Set<string> {
  const [bad, setBad] = useState<{ key: string; ids: Set<string> }>({ key: '', ids: new Set() })
  const todo = (messages ?? []).filter((m) => m.frank && m.messageType === 'text' && !m.undecryptable)
  const key = `${matchId}:${todo.map((m) => `${m.id}.${m.frank?.fc}`).join(',')}`
  useEffect(() => {
    if (!partnerPublicKey || !myPrivateKey || !todo.length) return
    let cancelled = false
    Promise.all(todo.map(async (m) => ((await checkFrank({ ...m.frank, senderId: m.senderId }, m.text, matchId, partnerPublicKey, myPrivateKey)) === 'bad' ? m.id : null))).then((ids) => {
      if (!cancelled) setBad({ key, ids: new Set(ids.filter((x): x is string => x !== null)) })
    })
    return () => {
      cancelled = true
    }
    // `key` covers the messages that need checking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, partnerPublicKey, myPrivateKey])
  return bad.key === key ? bad.ids : new Set()
}
