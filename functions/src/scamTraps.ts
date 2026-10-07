import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { scamCheck, scamExcerpt } from './shared/scamRules'

// T&S Phase 2 — bot scam traps. Curated profiles exist only while a city is
// founding, and what people send them is plaintext (nobody else's messages
// are readable by the server). Each message to one is checked with the
// shared scam rules; a hit keeps the matched excerpt — never the whole
// conversation — for SCAM_TRAP_KEEP_MS and flags the sender for review:
//   scamTrapHits/{auto}       { uid, matchId, messageId, hits, excerpt, at, expiresAt }
//   behaviorSignals/{uid}     scamTrap { count, hits, at } (last 90 days)

export const SCAM_TRAP_KEEP_MS = 90 * 24 * 60 * 60 * 1000
const db = () => getFirestore()

export async function recordScamTrap(uid: string, matchId: string, messageId: string, text: string): Promise<boolean> {
  const { flagged, hits } = scamCheck(text)
  if (!flagged) return false
  const now = Date.now()
  await db().doc(`scamTrapHits/${matchId}_${messageId}`).set({
    uid,
    matchId,
    messageId,
    hits,
    excerpt: scamExcerpt(text, hits),
    at: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(now + SCAM_TRAP_KEEP_MS),
  })
  const recent = await db().collection('scamTrapHits').where('uid', '==', uid).where('expiresAt', '>', Timestamp.now()).get()
  const allHits = [...new Set(recent.docs.flatMap((d) => (d.get('hits') ?? []) as string[]))]
  await db()
    .doc(`behaviorSignals/${uid}`)
    .set({ scamTrap: { count: recent.size, hits: allHits, at: now }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  logger.warn('scamTrap: a message to a curated profile matched scam patterns', { hits })
  return true
}

// Excerpts past SCAM_TRAP_KEEP_MS go (nightly), and the signal with them.
export const purgeScamTraps = onSchedule(
  { schedule: '40 2 * * *', timeZone: 'America/Chicago', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const due = await db().collection('scamTrapHits').where('expiresAt', '<=', Timestamp.now()).get()
    const uids = new Set(due.docs.map((d) => String(d.get('uid'))))
    for (let i = 0; i < due.size; i += 400) {
      const batch = db().batch()
      due.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref))
      await batch.commit()
    }
    for (const uid of uids) {
      const left = await db().collection('scamTrapHits').where('uid', '==', uid).get()
      const hits = [...new Set(left.docs.flatMap((d) => (d.get('hits') ?? []) as string[]))]
      await db()
        .doc(`behaviorSignals/${uid}`)
        .set({ scamTrap: left.empty ? FieldValue.delete() : { count: left.size, hits, at: Date.now() } }, { merge: true })
    }
    logger.info('purgeScamTraps', { deleted: due.size })
  },
)
