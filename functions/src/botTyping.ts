import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'

// "Bot is typing…" for bot chats. Bot replies come from the mobile codebase's
// onBotMessage (Claude call, then a 2–6s pause), which the web can't change,
// so typing is driven from the outside: botTypingStart shows the bot typing
// soon after someone messages it and keeps the stamp fresh; botTypingStop
// clears it the moment the bot's reply is written. Clients show the dots while
// typingAt is under 5s old (ChatView), so a reply that never comes clears
// itself once the refreshes stop.

const READ_DELAY_MS = 800 // "reads" the message before starting to type
const REFRESH_MS = 3000 // inside the client's 5s freshness window
const MAX_TYPING_MS = 20_000 // longest a reply has ever needed, with margin

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Same gate as onBotMessage: a match flagged isBot, or a legacy seed- bot.
function botUidFor(match: DocumentData, senderId: string): string | null {
  const users: unknown = match.users ?? match.participants
  if (!Array.isArray(users)) return null
  const other = users.find((u): u is string => typeof u === 'string' && u !== senderId)
  if (!other) return null
  return match.isBot === true || other.startsWith('seed-') ? other : null
}

export const botTypingStart = onDocumentCreated(
  { document: 'matches/{matchId}/messages/{messageId}', timeoutSeconds: 60, memory: '256MiB' },
  async (event) => {
    const msg = event.data?.data()
    if (!msg || msg.isBot === true || msg.nonce === 'system' || typeof msg.senderId !== 'string') return
    const db = getFirestore()
    const { matchId } = event.params
    const match = (await db.collection('matches').doc(matchId).get()).data()
    const botUid = match ? botUidFor(match, msg.senderId) : null
    if (!botUid) return

    const typingRef = db.doc(`matches/${matchId}/typing/${botUid}`)
    await sleep(READ_DELAY_MS)
    await typingRef.set({ typingAt: FieldValue.serverTimestamp(), uid: botUid })

    // Refresh until botTypingStop deletes the doc (update() then fails) or
    // the cap is reached.
    for (let waited = 0; waited < MAX_TYPING_MS; waited += REFRESH_MS) {
      await sleep(REFRESH_MS)
      try {
        await typingRef.update({ typingAt: FieldValue.serverTimestamp() })
      } catch {
        return // reply arrived
      }
    }
    await typingRef.delete().catch(() => {})
    logger.info('botTypingStart: no reply within the cap, cleared typing', { matchId })
  },
)

export const botTypingStop = onDocumentCreated(
  { document: 'matches/{matchId}/messages/{messageId}', timeoutSeconds: 30, memory: '256MiB' },
  async (event) => {
    const msg = event.data?.data()
    if (msg?.isBot !== true || typeof msg.senderId !== 'string') return
    await getFirestore().doc(`matches/${event.params.matchId}/typing/${msg.senderId}`).delete()
  },
)
