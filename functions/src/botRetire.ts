import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldPath, FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { ZYLOVE_CITIES } from './cities'

// Stage C: when a city's founding circle is full (50 + 50 founders, so
// config/city_{id}.botsActive turns false — founders.ts), Zylove's curated
// profiles (zbot-) leave that city's members entirely, not just Explore:
// their likes are taken out of everyone's "who liked you", and chats with
// them end with a note saying why. (Bots stay for cities still founding.)

const BOT_LO = 'zbot-'
const BOT_HI = 'zbot.' // '.' follows '-': exactly the zbot- ids
const NOTE =
  "This was a Zylove curated profile, shown while your city's community was being built. Your city's founding circle is now full, so curated profiles have been removed — everyone you meet from here is a real member."

export const retireBotsOnCityClose = onDocumentUpdated({ document: 'config/{docId}', timeoutSeconds: 540, memory: '512MiB' }, async (event) => {
  const { docId } = event.params
  if (!docId.startsWith('city_')) return
  const before = event.data?.before.data()
  const after = event.data?.after.data()
  if (before?.botsActive === false || after?.botsActive !== false) return
  const city = ZYLOVE_CITIES.find((c) => `city_${c.id}` === docId)
  if (!city) return
  const db = getFirestore()
  const [inMarket, linked] = await Promise.all([
    db.collection('userLocations').where('marketCityId', '==', city.id).select().get(),
    db.collection('userLocations').where('linkedCityId', '==', city.id).select().get(),
  ])
  const members = [...new Set([...inMarket.docs, ...linked.docs].map((d) => d.id))].filter((id) => !id.startsWith(BOT_LO))
  let likes = 0
  let chats = 0
  for (const uid of members) {
    const queue = await db
      .collection(`users/${uid}/likeQueue`)
      .where(FieldPath.documentId(), '>=', BOT_LO)
      .where(FieldPath.documentId(), '<', BOT_HI)
      .select()
      .get()
    for (const d of queue.docs) {
      await d.ref.delete()
      likes++
    }
    const matches = await db.collection('matches').where('users', 'array-contains', uid).get()
    for (const m of matches.docs) {
      const other = (m.get('users') as string[]).find((u) => u !== uid) ?? ''
      if (!other.startsWith(BOT_LO) || m.get('unmatchedAt')) continue
      await m.ref.collection('messages').add({ senderId: other, ciphertext: NOTE, nonce: 'system', messageType: 'text', status: 'sent', sentAt: FieldValue.serverTimestamp() })
      await m.ref.update({ unmatchedAt: Timestamp.now(), unmatchedBy: other, endedBy: 'curated_retired' })
      chats++
    }
  }
  logger.info('retireBotsOnCityClose', { city: city.id, members: members.length, likesRemoved: likes, chatsEnded: chats })
})
