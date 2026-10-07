import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { PLAY_TAG_LABELS, SPICE_META, type PlayInterestTag, type SpiceLevel } from './shared/dualProfile'
import { isSuspendedUid } from './userData'

// Demonstration profiles like back. When a real person likes a bot, the like
// lands in the bot's like queue (users/{bot}/likeQueue/{liker}, written by
// mobile's onLike for both apps). About 5 minutes later the bot likes back:
// the pair is marked matched, a match doc is created in the same shape onLike
// uses (flagged isBot so mobile's onBotMessage answers the conversation), and
// the bot opens with an AI-written first message that fits its profile.
//
// pendingBotLikes/{bot}_{liker} holds the queue (server-only: rules
// default-deny). Disclosed in Terms 2.4.

const anthropicKey = defineSecret('ANTHROPIC_API_KEY')
const MODEL = 'claude-sonnet-4-6'
const BOT_PREFIXES = ['zbot-', 'seed-']
const LIKE_BACK_DELAY_MS = 5 * 60 * 1000
const BATCH_LIMIT = 50
const PENDING = 'pendingBotLikes'

const isBotUid = (uid: string) => BOT_PREFIXES.some((p) => uid.startsWith(p))

type Mode = 'spark' | 'play'

export const queueBotLikeBack = onDocumentCreated('users/{botUid}/likeQueue/{likerUid}', async (event) => {
  const { botUid, likerUid } = event.params
  if (!isBotUid(botUid) || isBotUid(likerUid)) return
  const like = event.data?.data()
  const mode: Mode = like?.mode === 'play' || like?.mode === 'entanglement' ? 'play' : 'spark'
  await getFirestore()
    .collection(PENDING)
    .doc(`${botUid}_${likerUid}`)
    .set({
      botUid,
      likerUid,
      mode,
      dueAt: Timestamp.fromMillis(Date.now() + LIKE_BACK_DELAY_MS),
      createdAt: FieldValue.serverTimestamp(),
    })
})

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// The bot as Claude should play it, from its root profile (and Play profile in Play).
function botPersona(bot: DocumentData, play: DocumentData | undefined, mode: Mode): string {
  const prompts = (Array.isArray(mode === 'play' ? play?.promptAnswers : bot.promptAnswers)
    ? (mode === 'play' ? play?.promptAnswers : bot.promptAnswers)
    : []) as { answer?: unknown }[]
  const answers = prompts.map((p) => str(p?.answer)).filter(Boolean).slice(0, 3)
  const lines = [
    `Name: ${(mode === 'play' ? str(bot.playDisplayName) || str(play?.playDisplayName) || str(play?.displayName) : str(bot.displayName)) || 'Someone'}${typeof bot.age === 'number' ? `, ${bot.age}` : ''}`,
    `Bio: ${str(mode === 'play' ? play?.playBio : bot.bio) || 'none'}`,
  ]
  if (mode === 'play') {
    const spice = SPICE_META[str(play?.spiceLevel) as SpiceLevel]
    const arrangement = list(play?.playInterestTags)
      .filter((t) => PLAY_TAG_LABELS[t as PlayInterestTag]?.category === 'arrangement')
      .map((t) => PLAY_TAG_LABELS[t as PlayInterestTag].label)
    if (spice) lines.push(`Spice level: ${spice.label} — ${spice.description}`)
    if (arrangement.length) lines.push(`Looking for: ${arrangement.join(', ')}`)
  } else {
    const values = list(bot.relationshipValues).slice(0, 3)
    if (values.length) lines.push(`Values: ${values.join(', ').replace(/_/g, ' ')}`)
  }
  if (answers.length) lines.push(`In their own words: ${answers.join(' / ')}`)
  return lines.join('\n')
}

// In Play only their Play name and bio — never the Spark ones.
function theirDetails(user: DocumentData, play: DocumentData | undefined, mode: Mode): string {
  const bio = mode === 'play' ? str(play?.playBio) : str(user.bio)
  const name =
    (mode === 'play' ? str(user.playDisplayName) || str(play?.playDisplayName) : str(user.displayName)) || 'them'
  return [`Their name: ${name}`, bio ? `Their bio: ${bio.slice(0, 300)}` : ''].filter(Boolean).join('\n')
}

const FALLBACK_OPENERS: Record<Mode, string[]> = {
  spark: ['Your profile made me smile — what are you hoping to find here?', 'Okay, I have to ask — what does a perfect weekend look like for you?'],
  play: ["You caught my attention. What's your idea of a good time?", "Something about your profile says trouble — the good kind. What's your vibe tonight?"],
}

async function writeOpener(bot: DocumentData, botPlay: DocumentData | undefined, them: DocumentData, theirPlay: DocumentData | undefined, mode: Mode): Promise<string> {
  const prompt = [
    `You are this person on the dating app Zylove (${mode === 'play' ? 'Play — casual, adult, honest about what they want' : 'Spark — serious dating'}):`,
    botPersona(bot, botPlay, mode),
    '',
    'You just matched with someone:',
    theirDetails(them, theirPlay, mode),
    '',
    'Write your first message to them.',
    '- One or two sentences, under 30 words, in your own voice',
    '- Reference something specific about them if you can',
    mode === 'play'
      ? '- Flirty and confident to match your spice level and what you are looking for — suggestive at most, never explicit'
      : '- Warm and curious',
    '- End with something easy to answer',
    '- No emojis, no quotes, no greeting like "Hey!" on its own',
    '- Return ONLY the message',
  ].join('\n')
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey.value(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 120, messages: [{ role: 'user', content: prompt }] }),
    })
    if (response.ok) {
      const body = (await response.json()) as { content?: { text?: unknown }[] }
      const text = str(body.content?.[0]?.text).replace(/^["“]|["”]$/g, '')
      if (text.length >= 3) return text
    } else {
      logger.error('botLikeBack: opener API error', { status: response.status })
    }
  } catch (err) {
    logger.error('botLikeBack: opener failed', { message: String(err) })
  }
  const options = FALLBACK_OPENERS[mode]
  return options[Math.floor(Math.random() * options.length)]
}

// A Play match (`play` = their playProfile/data, {} if none) snapshots the
// Play name and Play photo — never the Spark photo.
function snapshot(user: DocumentData, play?: DocumentData) {
  return {
    displayName: play
      ? str(user.playDisplayName) || str(play.playDisplayName) || str(play.displayName) || 'Someone new'
      : str(user.displayName) || 'Someone new',
    photoURL: list((play ?? user).photoURLs)[0] ?? null,
    age: typeof user.age === 'number' ? user.age : null,
    isVerified: false,
    zyloveScoreTier: '',
  }
}

// One like-back: match (unless one already exists), then the opener.
async function likeBack(pendingRef: FirebaseFirestore.DocumentReference, pending: DocumentData): Promise<void> {
  const db = getFirestore()
  const botUid = str(pending.botUid)
  const likerUid = str(pending.likerUid)
  const mode: Mode = pending.mode === 'play' ? 'play' : 'spark'
  const [userA, userB] = [botUid, likerUid].sort()
  const matchId = `${userA}_${userB}`
  const matchRef = db.collection('matches').doc(matchId)
  const pairRef = db.collection('pairs').doc(matchId)
  const botRef = db.collection('users').doc(botUid)
  const likerRef = db.collection('users').doc(likerUid)

  // Play data for the snapshots and the opener.
  const [botPlay, likerPlay] =
    mode === 'play'
      ? await Promise.all([
          botRef.collection('playProfile').doc('data').get().then((s) => s.data(), () => undefined),
          likerRef.collection('playProfile').doc('data').get().then((s) => s.data(), () => undefined),
        ])
      : [undefined, undefined]

  // Suspension is in userInternal (Stage 3).
  const likerSuspended = await isSuspendedUid(likerUid)
  const created = await db.runTransaction(async (tx) => {
    const [match, bot, liker] = await Promise.all([tx.get(matchRef), tx.get(botRef), tx.get(likerRef)])
    tx.delete(pendingRef)
    // Already matched (the bot liked them first), or either side is gone.
    if (match.exists || !bot.exists || !liker.exists || likerSuspended) return null
    // Stage B: the like is recorded per mode, server-only; the pair doc
    // (readable by both) only names the two people.
    tx.set(pairRef, { userA, userB }, { merge: true })
    tx.set(db.doc(`pairs/${matchId}/likes/${mode}`), { likedBy: FieldValue.arrayUnion(botUid, likerUid) }, { merge: true })
    const now = Timestamp.now()
    tx.create(matchRef, {
      matchId,
      users: [userA, userB],
      participants: [userA, userB],
      mode,
      pairId: matchId,
      // matchGeneration = matchedAt (see matchGeneration.ts).
      matchedAt: now,
      createdAt: now,
      matchGeneration: now.toMillis(),
      conversationId: matchId,
      participantSnapshots: {
        [botUid]: snapshot(bot.data() ?? {}, mode === 'play' ? (botPlay ?? {}) : undefined),
        [likerUid]: snapshot(liker.data() ?? {}, mode === 'play' ? (likerPlay ?? {}) : undefined),
      },
      hasUnread: false,
      isBlocked: false,
      isBot: true,
      botUid,
      lastMessage: null,
      lastMessagePreview: null,
      lastMessageAt: null,
    })
    tx.set(db.doc(`users/${userA}/matches/${matchId}`), { matchId, otherUid: userB, createdAt: now, mode })
    tx.set(db.doc(`users/${userB}/matches/${matchId}`), { matchId, otherUid: userA, createdAt: now, mode })
    // The like is answered: clear both inbox entries, as onLike does on a match.
    tx.delete(db.doc(`users/${botUid}/likeQueue/${likerUid}`))
    tx.delete(db.doc(`users/${likerUid}/likeQueue/${botUid}`))
    return { bot: bot.data() ?? {}, liker: liker.data() ?? {} }
  })
  if (!created) return

  const opener = await writeOpener(created.bot, botPlay, created.liker, likerPlay, mode)
  // Plaintext with a 'stub' nonce, like every bot message.
  await matchRef.collection('messages').add({
    senderId: botUid,
    ciphertext: opener,
    nonce: 'stub',
    messageType: 'text',
    status: 'sent',
    sentAt: FieldValue.serverTimestamp(),
    isBot: true,
  })
  await matchRef.update({
    lastMessagePreview: 'New message',
    lastMessageAt: FieldValue.serverTimestamp(),
    lastSenderId: botUid,
    hasUnread: true,
  })
  logger.info('botLikeBack: matched and opened', { matchId, mode })
}

// Every minute, so a like-back lands 5–6 minutes after the like.
export const processBotLikeBacks = onSchedule(
  { schedule: 'every 1 minutes', timeoutSeconds: 120, memory: '256MiB', secrets: [anthropicKey] },
  async () => {
    const due = await getFirestore()
      .collection(PENDING)
      .where('dueAt', '<=', Timestamp.now())
      .limit(BATCH_LIMIT)
      .get()
    for (const d of due.docs) {
      await likeBack(d.ref, d.data()).catch((err: unknown) =>
        logger.error('botLikeBack failed', { id: d.id, message: err instanceof Error ? err.message : String(err) }),
      )
    }
    if (due.size) logger.info('processBotLikeBacks', { processed: due.size })
  },
)
