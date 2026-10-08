import { createHash } from 'node:crypto'
import { logger } from 'firebase-functions'
import { FieldValue, getFirestore, type DocumentData, type QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { MAX_DISTANCE, bandKeys, dHash, hamming, probeKeys } from './photoHashCore'
import type { BanContext, StoredMatch } from './blocklistContext'

// T&S Phase 5 — duplicate photos. Server-only; hashes are not images.
//   photoHashes/{id}     { uid, path, mode, hash, bands, at }   while the photo exists
//   photoBlocklist/{id}  { uid, path, hash, bands, bannedAt, by, name, adminMarkedScam,
//                        reports } photos of accounts banned for scams/fraud, with
//                        the ban's context — kept while the ban stands
//   photoDuplicates/{a__b} { uids: [a, b], photos: { [a]: path, [b]: path }[], distance,
//                        status, at } — the same or near-same photo on two accounts,
//                        for side-by-side review
// A near-match on another account flags BOTH accounts (risk score) — never
// rejects. A match on the blocklist holds the photo from publishing (pending
// review) — never deletes it. The same account reusing its own photo (say in
// Spark and Play) is not a match.

const db = () => getFirestore()
const idOf = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 32)
const pairId = (a: string, b: string) => [a, b].sort().join('__')

export interface NearMatch {
  id: string
  uid: string
  path: string
  distance: number
  data: DocumentData
}

// Every doc in `col` within MAX_DISTANCE of `hash` (multi-probe band search).
export async function nearMatches(col: 'photoHashes' | 'photoBlocklist', hash: string): Promise<NearMatch[]> {
  const keys = probeKeys(hash)
  const docs = new Map<string, QueryDocumentSnapshot>()
  for (let i = 0; i < keys.length; i += 30) {
    const snap = await db().collection(col).where('bands', 'array-contains-any', keys.slice(i, i + 30)).get()
    for (const d of snap.docs) docs.set(d.id, d)
  }
  return [...docs.values()]
    .map((d) => ({ id: d.id, uid: String(d.get('uid')), path: String(d.get('path')), distance: hamming(hash, String(d.get('hash'))), data: d.data() }))
    .filter((m) => m.distance <= MAX_DISTANCE)
    .sort((a, b) => a.distance - b.distance)
}

// The closest blocklist match, with the ban's context as recorded at ban time.
function storedMatch(m: NearMatch): StoredMatch {
  const reports = m.data.reports
  return {
    uid: m.uid,
    name: typeof m.data.name === 'string' ? m.data.name : '',
    bannedAt: typeof m.data.bannedAt === 'number' ? m.data.bannedAt : null,
    adminMarkedScam: m.data.adminMarkedScam === true,
    reports: typeof reports === 'object' && reports !== null ? (reports as Record<string, number>) : {},
    distance: m.distance,
  }
}

// After a photo is hashed: record it, check the blocklist, flag duplicates.
// `blocklisted` is the closest blocklist match (with its ban context) and
// `blocklistMore` how many other blocklist entries matched too.
export async function checkPhoto(
  uid: string,
  path: string,
  mode: 'spark' | 'play',
  bytes: Buffer,
): Promise<{ hash: string; blocklisted: StoredMatch | null; blocklistMore: number; duplicates: NearMatch[] }> {
  const hash = await dHash(bytes)
  const blocked = (await nearMatches('photoBlocklist', hash)).filter((m) => m.uid !== uid)
  await db().doc(`photoHashes/${idOf(path)}`).set({ uid, path, mode, hash, bands: bandKeys(hash), at: Date.now() })
  const duplicates = (await nearMatches('photoHashes', hash)).filter((m) => m.uid !== uid)
  for (const d of duplicates) {
    const ref = db().doc(`photoDuplicates/${pairId(uid, d.uid)}`)
    await db().runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      const photos = ((cur?.photos ?? []) as Record<string, string>[]).filter((p) => !(p[uid] === path && p[d.uid] === d.path))
      photos.push({ [uid]: path, [d.uid]: d.path })
      tx.set(ref, { uids: [uid, d.uid].sort(), photos: photos.slice(-20), distance: Math.min(d.distance, cur?.distance ?? 64), status: 'open', at: Date.now() })
    })
  }
  if (duplicates.length) await Promise.all([uid, ...new Set(duplicates.map((d) => d.uid))].map(refreshDuplicateSignal))
  if (blocked.length) {
    await db().doc(`behaviorSignals/${uid}`).set({ blocklistPhoto: { at: Date.now(), distance: blocked[0].distance }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  }
  return { hash, blocklisted: blocked.length ? storedMatch(blocked[0]) : null, blocklistMore: Math.max(0, blocked.length - 1), duplicates }
}

// behaviorSignals/{uid}.duplicatePhotos { accounts, at } — other accounts that
// share a photo with this one (open pairs).
async function refreshDuplicateSignal(uid: string): Promise<void> {
  const open = await db().collection('photoDuplicates').where('uids', 'array-contains', uid).where('status', '==', 'open').get()
  await db()
    .doc(`behaviorSignals/${uid}`)
    .set({ duplicatePhotos: open.empty ? FieldValue.delete() : { accounts: open.size, at: Date.now() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
}

// A photo's file is gone (photoHashTrigger.ts): its hash goes, and it
// leaves any duplicate pair.
export async function forgetPhoto(path: string): Promise<void> {
  const ref = db().doc(`photoHashes/${idOf(path)}`)
  const h = (await ref.get()).data()
  if (!h) return
  await ref.delete()
  const pairs = await db().collection('photoDuplicates').where('uids', 'array-contains', h.uid).get()
  const touched = new Set<string>()
  for (const p of pairs.docs) {
    const photos = ((p.get('photos') ?? []) as Record<string, string>[]).filter((x) => !Object.values(x).includes(path))
    if (photos.length === ((p.get('photos') ?? []) as unknown[]).length) continue
    if (photos.length) await p.ref.update({ photos })
    else await p.ref.delete()
    ;(p.get('uids') as string[]).forEach((u) => touched.add(u))
  }
  await Promise.all([...touched].map(refreshDuplicateSignal))
}

// On a ban for scams/fraud: the account's photo hashes join the blocklist
// (before its photos are deleted), kept while the ban stands, with the ban's
// context (name, why) — a later hold shows it even once the account is gone.
export async function blocklistPhotosOf(uid: string, by: string, ctx: BanContext): Promise<number> {
  const hashes = await db().collection('photoHashes').where('uid', '==', uid).get()
  const batch = db().batch()
  for (const d of hashes.docs) {
    const h = d.data() as DocumentData
    batch.set(db().doc(`photoBlocklist/${d.id}`), { uid, path: h.path, hash: h.hash, bands: h.bands, bannedAt: Date.now(), by, name: ctx.name, adminMarkedScam: ctx.adminMarkedScam, reports: ctx.reports })
  }
  if (hashes.size) await batch.commit()
  logger.info('blocklistPhotosOf', { photos: hashes.size })
  return hashes.size
}

// A ban overturned: its photos leave the blocklist.
export async function unblockPhotosOf(uid: string): Promise<number> {
  const listed = await db().collection('photoBlocklist').where('uid', '==', uid).get()
  await Promise.all(listed.docs.map((d) => d.ref.delete()))
  return listed.size
}

// With the account (clearPrivateData): its hashes and duplicate pairs.
export async function removePhotoHashes(uid: string): Promise<void> {
  const [hashes, pairs] = await Promise.all([
    db().collection('photoHashes').where('uid', '==', uid).get(),
    db().collection('photoDuplicates').where('uids', 'array-contains', uid).get(),
  ])
  await Promise.all([...hashes.docs, ...pairs.docs].map((d) => d.ref.delete()))
  const others = new Set(pairs.docs.flatMap((p) => (p.get('uids') as string[]).filter((u) => u !== uid)))
  await Promise.all([...others].map(refreshDuplicateSignal))
}
