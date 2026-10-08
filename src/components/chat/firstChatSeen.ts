import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { matchPath } from '../../services/playId'
import { db } from '../../services/firebase'

// Web tracks the first-chat modal per match in localStorage, mirrored to the
// match doc's safetyCardShown — the flag mobile's FirstMessageSafetyCard reads
// and writes — so dismissing on either platform hides it on both.
function seenKey(matchId: string): string {
  return `zylove_chat_seen_${matchId}`
}

export function firstChatSeen(matchId: string): boolean {
  try {
    return localStorage.getItem(seenKey(matchId)) === '1'
  } catch {
    // Storage unavailable — don't nag on every open.
    return true
  }
}

function markLocal(matchId: string): void {
  try {
    localStorage.setItem(seenKey(matchId), '1')
  } catch {
    // Storage unavailable — the modal just closes for this session.
  }
}

export function markFirstChatSeen(matchId: string): void {
  markLocal(matchId)
  // Same fields mobile writes. Best effort: localStorage already hides it here.
  updateDoc(doc(db, matchPath(matchId)), { safetyCardShown: true, safetyCardShownAt: Date.now() }).catch(() => {})
}

// True when the card was already dismissed on another device (e.g. mobile).
export async function firstChatSeenRemotely(matchId: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, matchPath(matchId)))
    const shown = snap.data()?.safetyCardShown === true
    if (shown) markLocal(matchId)
    return shown
  } catch {
    return false
  }
}
