import { doc, getDoc } from 'firebase/firestore'
import { db } from '../../services/firebase'
import { isPlayId } from '../../services/playId'
import { useEffect, useState } from 'react'
import { fetchPublicUserDoc } from '../../services/publicUserDoc'
import { NEW_ACCOUNT_MS } from '../../services/scamRules'

// T&S Phase 2 — what the chat's on-device safety checks need (ChatSafety.tsx).

export interface SenderTrust {
  newUntil: number | null // the sender's account was under 48h old until then
  founder: boolean
}

// The partner's public newUntil / founder flag (null while loading).
export function useSenderTrust(uid: string, skip: boolean): SenderTrust | null {
  const [loaded, setLoaded] = useState<{ uid: string; trust: SenderTrust } | null>(null)
  useEffect(() => {
    if (skip) return
    let cancelled = false
    // F-062: a Play partner's new-account marker is on their public Play
    // profile (by Play ID); founder status isn't shown in Play.
    const read: Promise<{ newUntil?: unknown; isFounder?: unknown } | null> = isPlayId(uid)
      ? getDoc(doc(db, `playProfiles/${uid}`)).then((s) => (s.data() ?? null) as { newUntil?: unknown } | null, () => null)
      : fetchPublicUserDoc(uid)
    read.then((d) => {
      if (!cancelled) setLoaded({ uid, trust: { newUntil: typeof d?.newUntil === 'number' ? d.newUntil : null, founder: d?.isFounder === true } })
    })
    return () => {
      cancelled = true
    }
  }, [uid, skip])
  return loaded?.uid === uid ? loaded.trust : null
}

// Whether this account may send a link yet: 48 hours after it was created
// (Firebase Auth's record), or a founder.
export function useCanSendLinks(uid: string, creationTime: string | undefined): boolean {
  const [founder, setFounder] = useState<{ uid: string; founder: boolean } | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchPublicUserDoc(uid).then((d) => {
      if (!cancelled) setFounder({ uid, founder: d?.isFounder === true })
    })
    return () => {
      cancelled = true
    }
  }, [uid])
  const created = Date.parse(creationTime ?? '')
  const [now] = useState(() => Date.now())
  if (founder?.uid === uid && founder.founder) return true
  return !Number.isFinite(created) || now - created >= NEW_ACCOUNT_MS
}
export const LINKS_LATER = 'Links can be shared once your account is a little older. Everything else sends as usual.'
