import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { generationOf } from './matchGeneration'
import { loadMatch } from './playMatch'
import { recordScamTrap } from './scamTraps'
import { isDeletedUid } from './userData'
import { takeRateLimit } from './rateLimits'

// T&S Phase 1 — behaviour signals that need no message content.
//
// behaviorSignals/{uid} (server-only) gains:
//   messagesSent, messagesReceived           every text/photo message
//   conversationsStarted, conversationsReceived  first message in a match
//   repliesGiven, repliesReceived            first reply to the other's opener
//   capHitDays [YYYY-MM-DD, last 30]         days a like/deck cap was hit
//   duplicateOpener {recipients24h, senders24h, at}  copy-pasted openers
// matchStats/{matchId}_{gen} (server-only): who wrote first and how much —
//   deleted with the match (purgeMatchContent).
// openerHashes/{hash} (server-only): who sent an opener with that hash to
//   whom, for OPENER_KEEP_MS; the hash is computed on the sender's device
//   (keyed, normalized, 20+ characters) and dropped from the message once
//   recorded. No message content is ever stored.

const SIGNALS = 'behaviorSignals'
const DAY_MS = 24 * 60 * 60 * 1000
export const OPENER_KEEP_MS = 14 * DAY_MS
const CAP_DAYS_KEPT = 30

const db = () => getFirestore()
const signalRef = (uid: string) => db().collection(SIGNALS).doc(uid)
// F-096: never for a deleted account (a message counted after the deletion
// would bring back the behaviorSignals it removed).
const inc = async (uid: string, fields: Record<string, number>) => {
  if (await isDeletedUid(uid)) return
  await signalRef(uid).set(
    { ...Object.fromEntries(Object.entries(fields).map(([k, n]) => [k, FieldValue.increment(n)])), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  )
}

function dayKey(ms = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

// A like or deck cap was hit today (the cap itself is enforced elsewhere).
export async function recordCapHit(uid: string): Promise<void> {
  const ref = signalRef(uid)
  await db()
    .runTransaction(async (tx) => {
      const days = ((await tx.get(ref)).data()?.capHitDays ?? []) as string[]
      const today = dayKey()
      if (days.includes(today)) return
      tx.set(ref, { capHitDays: [...days, today].slice(-CAP_DAYS_KEPT), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    })
    .catch((err: unknown) => logger.warn('recordCapHit failed', { message: err instanceof Error ? err.message : String(err) }))
}

// Counts per message: sender, type and time only.
export const trustOnMessage = onDocumentCreated(
  { document: 'matches/{matchId}/messages/{messageId}', memory: '256MiB', timeoutSeconds: 60 },
  async (event) => countMessage(event.params.matchId, event.params.messageId, event.data?.data(), event.data?.ref),
)
// F-062: Play messages — the sender's Play ID mapped back to the account.
export const trustOnPlayMessage = onDocumentCreated(
  { document: 'playMatches/{matchId}/messages/{messageId}', memory: '256MiB', timeoutSeconds: 60 },
  async (event) => countMessage(event.params.matchId, event.params.messageId, event.data?.data(), event.data?.ref),
)

async function countMessage(
  matchId: string,
  messageId: string,
  m: FirebaseFirestore.DocumentData | undefined,
  ref: FirebaseFirestore.DocumentReference | undefined,
): Promise<void> {
    if (!m) return
    const fh: unknown = m.fh
    const dropHash = () => (typeof fh === 'string' ? ref?.update({ fh: FieldValue.delete() }).catch(() => {}) : undefined)
    const type = m.messageType ?? 'text'
    if (m.isBot === true || m.nonce === 'system' || (type !== 'text' && type !== 'photo')) return void (await dropHash())
    const ctx = await loadMatch(matchId)
    const match = ctx?.data
    const users = ctx?.users ?? []
    const sender = typeof m.senderId === 'string' ? ctx?.uidOf(m.senderId) : null
    if (typeof sender === 'string' && !/^(zbot|seed)-/.test(sender)) await noteMessageRate(sender)
    const recipient = users.find((u) => u !== sender)
    const botChat = match?.isBot === true || users.some((u) => /^(zbot|seed)-/.test(u))
    // T&S Phase 2: what a person sends a curated profile is plaintext — the
    // one place the server may read a message — and is checked for scams.
    if (botChat && typeof sender === 'string' && !/^(zbot|seed)-/.test(sender) && type === 'text' && (m.nonce === 'stub' || m.nonce === 'stub-nonce') && typeof m.ciphertext === 'string') {
      await recordScamTrap(sender, matchId, messageId, m.ciphertext)
    }
    if (typeof sender !== 'string' || !recipient || botChat) return void (await dropHash())
    const statsRef = db().doc(`matchStats/${matchId}_${generationOf(match)}`)
    const { firstFromSender, otherStarted } = await db().runTransaction(async (tx) => {
      const s = (await tx.get(statsRef)).data() ?? {}
      const first = (s.first ?? {}) as Record<string, number>
      const firstFromSender = first[sender] === undefined
      tx.set(
        statsRef,
        {
          users,
          counts: { [sender]: FieldValue.increment(1) },
          ...(firstFromSender ? { first: { [sender]: Date.now() } } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      return { firstFromSender, otherStarted: first[recipient] !== undefined }
    })
    const writes: Promise<unknown>[] = [inc(sender, { messagesSent: 1 }), inc(recipient, { messagesReceived: 1 })]
    if (firstFromSender) {
      if (otherStarted) writes.push(inc(sender, { repliesGiven: 1 }), inc(recipient, { repliesReceived: 1 }))
      else writes.push(inc(sender, { conversationsStarted: 1 }), inc(recipient, { conversationsReceived: 1 }))
      if (typeof fh === 'string' && /^[a-f0-9]{64}$/.test(fh)) writes.push(recordOpenerHash(sender, recipient, fh))
    }
    await Promise.all(writes)
    await dropHash()
}

// F-123 (M12): how fast one account sends messages, across all its chats.
// Past MESSAGE_BURST in 10 minutes or MESSAGE_DAY in a day, its messages are
// paused for MESSAGE_MUTE_MS: the rules refuse new ones while
// userInternal.messagesMutedUntil is ahead (each message fires about seven
// triggers, and two colluding accounts could otherwise write without limit).
export const MESSAGE_BURST = 150
export const MESSAGE_DAY = 1500
export const MESSAGE_MUTE_MS = 60 * 60 * 1000

async function noteMessageRate(uid: string): Promise<void> {
  try {
    await takeRateLimit(uid, 'messagesBurst', { max: MESSAGE_BURST, windowMs: 10 * 60 * 1000 })
    await takeRateLimit(uid, 'messagesDay', { max: MESSAGE_DAY, windowMs: 24 * 60 * 60 * 1000 })
  } catch {
    await db().doc(`userInternal/${uid}`).set({ messagesMutedUntil: Timestamp.fromMillis(Date.now() + MESSAGE_MUTE_MS) }, { merge: true })
    logger.warn('trustSignals: messages paused for a sending burst')
  }
}

// The same opener (by on-device hash) to many people within a day.
async function recordOpenerHash(sender: string, recipient: string, hash: string): Promise<void> {
  const ref = db().doc(`openerHashes/${hash}`)
  const now = Date.now()
  const stats = await db().runTransaction(async (tx) => {
    const raw = ((await tx.get(ref)).data()?.entries ?? []) as { s: string; r: string; at: number }[]
    const entries = [...raw.filter((e) => now - e.at < OPENER_KEEP_MS), { s: sender, r: recipient, at: now }].slice(-500)
    tx.set(ref, { entries, expiresAt: Timestamp.fromMillis(now + OPENER_KEEP_MS) })
    const day = entries.filter((e) => now - e.at < DAY_MS)
    return {
      recipients24h: new Set(day.filter((e) => e.s === sender).map((e) => e.r)).size,
      senders24h: new Set(day.map((e) => e.s)).size,
    }
  })
  if (stats.recipients24h < 2 && stats.senders24h < 2) return
  if (await isDeletedUid(sender)) return
  await db().runTransaction(async (tx) => {
    const ref2 = signalRef(sender)
    const cur = ((await tx.get(ref2)).data()?.duplicateOpener ?? {}) as { recipients24h?: number; senders24h?: number; at?: number }
    const fresh = typeof cur.at === 'number' && now - cur.at < 7 * DAY_MS
    tx.set(
      ref2,
      {
        duplicateOpener: {
          recipients24h: Math.max(stats.recipients24h, fresh ? (cur.recipients24h ?? 0) : 0),
          senders24h: Math.max(stats.senders24h, fresh ? (cur.senders24h ?? 0) : 0),
          at: now,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
  })
}

// Opener hashes past OPENER_KEEP_MS go (nightly).
export const purgeOpenerHashes = onSchedule(
  { schedule: '50 2 * * *', timeZone: 'America/Chicago', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    let deleted = 0
    for (;;) {
      const due = await db().collection('openerHashes').where('expiresAt', '<=', Timestamp.now()).limit(400).get()
      if (due.empty) break
      const batch = db().batch()
      due.docs.forEach((d) => batch.delete(d.ref))
      await batch.commit()
      deleted += due.size
    }
    logger.info('purgeOpenerHashes', { deleted })
  },
)
