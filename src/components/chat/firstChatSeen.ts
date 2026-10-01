// Web tracks the first-chat modal per match in localStorage.
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

export function markFirstChatSeen(matchId: string): void {
  try {
    localStorage.setItem(seenKey(matchId), '1')
  } catch {
    // Storage unavailable — the modal just closes for this session.
  }
}
