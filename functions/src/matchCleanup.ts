import { logger } from 'firebase-functions'
import { Timestamp, getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { generationOf } from './matchGeneration'

// Deletes what an ended match leaves behind: its messages and its chat
// photos (chat-photos/{matchId}/..., web and mobile alike). Run when the
// match doc is deleted (mobile's unmatch).
//
// cutoff: only content from before this time (ms) is removed, so a
// re-match's new conversation is never touched. null = everything, unless
// the pair has re-matched since the delete — then the new doc's generation
// becomes the cutoff.
export async function purgeMatchContent(matchId: string, cutoff: number | null): Promise<void> {
  const db = getFirestore()
  const matchRef = db.collection('matches').doc(matchId)
  const limit = cutoff ?? (generationOf((await matchRef.get()).data()) || null)

  const messages = matchRef.collection('messages')
  let deleted = 0
  if (limit === null) {
    deleted = (await messages.count().get()).data().count
    await db.recursiveDelete(messages)
    await db.recursiveDelete(matchRef.collection('typing'))
  } else {
    const writer = db.bulkWriter()
    const old = await messages.where('sentAt', '<', Timestamp.fromMillis(limit)).select().get()
    for (const d of old.docs) void writer.delete(d.ref)
    await writer.close()
    deleted = old.size
  }

  const [files] = await getStorage()
    .bucket()
    .getFiles({ prefix: `chat-photos/${matchId}/` })
  const doomed = files.filter((f) => {
    if (limit === null) return true
    const created = Date.parse(String(f.metadata.timeCreated ?? ''))
    // Unknown upload time: keep it rather than risk the new conversation.
    return Number.isFinite(created) && created < limit
  })
  await Promise.all(doomed.map((f) => f.delete({ ignoreNotFound: true })))

  logger.info('purgeMatchContent', { matchId, cutoff: limit, messages: deleted, photos: doomed.length })
}
