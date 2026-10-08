import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { Timestamp, getFirestore } from 'firebase-admin/firestore'
import { parseKeys, serverTag } from './frankingCore'

// T&S Phase 4 — the server half of franking (design in frankingCore.ts).
// Every message that arrives with a commitment `fc` gets a tag, bound to the
// authenticated sender (Firestore rules make senderId the writer), the match,
// the message id and the server's clock:
//   franking/{matchId}_{msgId} (server-only)
//     { r, v, sender, matchId, msgId, at, fc, cid, seq, expiresAt }
// No content. Kept while the match lives; when its messages are purged the
// tags stay FRANKING_AFTER_PURGE_MS more (a report can still verify), then go.

export const FRANKING_KEY = defineSecret('FRANKING_KEY')
export const FRANKING_AFTER_PURGE_MS = 30 * 24 * 60 * 60 * 1000
const db = () => getFirestore()

export const frankOnMessage = onDocumentCreated(
  { document: 'matches/{matchId}/messages/{messageId}', secrets: [FRANKING_KEY], memory: '256MiB', timeoutSeconds: 30 },
  async (event) => frank(event.params.matchId, event.params.messageId, event.data?.data(), event.time),
)
// F-062: Play messages (playMatches/{pm_…}). The tag binds the sender as the
// message names them — their Play ID; evidence.ts maps it back server-side.
export const frankOnPlayMessage = onDocumentCreated(
  { document: 'playMatches/{matchId}/messages/{messageId}', secrets: [FRANKING_KEY], memory: '256MiB', timeoutSeconds: 30 },
  async (event) => frank(event.params.matchId, event.params.messageId, event.data?.data(), event.time),
)

async function frank(matchId: string, messageId: string, m: FirebaseFirestore.DocumentData | undefined, time: string): Promise<void> {
    if (!m || typeof m.fc !== 'string' || !/^[a-f0-9]{64}$/.test(m.fc) || typeof m.senderId !== 'string') return
    if (typeof m.cid !== 'string' || typeof m.seq !== 'number') return
    const at = m.sentAt instanceof Timestamp ? m.sentAt.toMillis() : Date.parse(time)
    const [{ v, key }] = parseKeys(FRANKING_KEY.value())
    await db()
      .doc(`franking/${matchId}_${messageId}`)
      .create({ r: serverTag(key, m.fc, m.senderId, matchId, messageId, at), v, sender: m.senderId, matchId, msgId: messageId, at, fc: m.fc, cid: m.cid, seq: m.seq, expiresAt: null })
      .catch((err: unknown) => {
        // At-least-once delivery: a retry finds the tag already there.
        if ((err as { code?: number }).code !== 6) throw err
      })
}

// The match's messages were purged (before `cutoff`, or all): their tags go
// FRANKING_AFTER_PURGE_MS later.
export async function expireFranking(matchId: string, cutoff: number | null): Promise<void> {
  const tags = await db().collection('franking').where('matchId', '==', matchId).get()
  const due = Timestamp.fromMillis(Date.now() + FRANKING_AFTER_PURGE_MS)
  const writer = db().bulkWriter()
  let n = 0
  for (const d of tags.docs) {
    if (d.get('expiresAt') || (cutoff !== null && Number(d.get('at')) >= cutoff)) continue
    void writer.update(d.ref, { expiresAt: due })
    n++
  }
  await writer.close()
  if (n) logger.info('expireFranking', { tags: n })
}
