// Stage 1b photo migration (F-021, F-031). Used by scripts/migrate-stage1b.mjs
// and the regression suite.
//
// Profile photos were stored as permanent links — signed URLs valid until
// 2500 and Firebase download-token URLs — that work for anyone who has one,
// whatever the Storage rules say. This:
//
//   1. copies every object under photos/ to a new name (marked
//      zyloveCopy=1 so onPhotoUpload doesn't moderate it again, and without
//      a download token),
//   2. rewrites every reference to the photo's new Storage path — profiles,
//      profile subdocs, pending queues, like-queue and match snapshots,
//      reports, deletion records, the moderation log (URLs of files that no
//      longer exist become their old path, which resolves to nothing),
//   3. moves Play photos in review from playProfile/data to private/account,
//   4. deletes the originals, so every old link stops working.
//
// Bot photos (bot-photos/, public fixtures) are left as they are.

import { randomUUID } from 'node:crypto'

const REF_RE = /^photos\/[^/]+\/(spark|play)\/[^/]+$/

export function isPhotoRef(v) {
  return typeof v === 'string' && REF_RE.test(v)
}

// The object path a stored value points at (a path, or either URL shape).
export function pathOf(v) {
  if (typeof v !== 'string') return null
  if (isPhotoRef(v)) return v
  try {
    const u = new URL(v)
    if (u.hostname === 'storage.googleapis.com') return decodeURIComponent(u.pathname.split('/').slice(2).join('/'))
    const m = /^\/v0\/b\/[^/]+\/o\/(.+)$/.exec(u.pathname)
    return m ? decodeURIComponent(m[1]) : null
  } catch {
    return null
  }
}

// ─── Plan ────────────────────────────────────────────────────────────────────

// Objects to move: everything under photos/ that isn't already a copy.
export async function planObjects(bucket) {
  const [files] = await bucket.getFiles({ prefix: 'photos/' })
  const moves = []
  for (const f of files) {
    if (!REF_RE.test(f.name)) continue
    if (f.metadata?.metadata?.zyloveCopy === '1') continue
    const [, uid, mode, name] = f.name.split('/')
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : 'jpg'
    moves.push({
      from: f.name,
      to: `photos/${uid}/${mode}/${Date.now()}-${randomUUID().slice(0, 12)}.${ext}`,
      contentType: f.metadata?.contentType ?? 'image/jpeg',
      hasToken: !!f.metadata?.metadata?.firebaseStorageDownloadTokens,
    })
  }
  return moves
}

// A stored value → its new reference. Bot and other non-photos/ URLs are
// unchanged.
export function mapValue(v, map) {
  const path = pathOf(v)
  if (!path) return v
  if (map.has(path)) return map.get(path)
  return path.startsWith('photos/') ? path : v
}

const mapList = (list, map) => (Array.isArray(list) ? list.map((v) => mapValue(v, map)) : list)
const mapPending = (list, map, mode) =>
  Array.isArray(list) ? list.map((p) => (p && typeof p === 'object' ? { ...p, url: mapValue(p.url, map), ...(mode && !p.mode ? { mode } : {}) } : p)) : list
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Firestore updates, as [{ path, data, merge?, note }].
export async function planDocs(db, map) {
  const updates = []
  const push = (ref, before, after, note, merge = false) => {
    const data = {}
    for (const k of Object.keys(after)) if (!same(before[k], after[k])) data[k] = after[k]
    if (Object.keys(data).length) updates.push({ path: ref.path, data, merge, note })
  }

  for (const d of (await db.collection('users').get()).docs) {
    const u = d.data()
    push(d.ref, u, { photoURLs: mapList(u.photoURLs, map), ...(u.pendingPhotoURLs ? { pendingPhotoURLs: mapPending(u.pendingPhotoURLs, map, 'spark') } : {}) }, 'users.photoURLs')
  }
  for (const d of (await db.collectionGroup('sparkProfile').get()).docs) {
    if (d.get('photoURLs') !== undefined) push(d.ref, d.data(), { photoURLs: mapList(d.get('photoURLs'), map) }, 'sparkProfile.photoURLs')
  }
  // Play: published photos rewritten; photos in review move to private/account.
  const playPending = new Map()
  for (const d of (await db.collectionGroup('playProfile').get()).docs) {
    const p = d.data()
    if (p.photoURLs !== undefined) push(d.ref, p, { photoURLs: mapList(p.photoURLs, map) }, 'playProfile.photoURLs')
    if (Array.isArray(p.pendingPhotoURLs)) {
      updates.push({ path: d.ref.path, data: { pendingPhotoURLs: '__DELETE__' }, merge: true, note: 'playProfile.pendingPhotoURLs → account' })
      if (p.pendingPhotoURLs.length) playPending.set(d.ref.parent.parent.id, mapPending(p.pendingPhotoURLs, map, 'play'))
    }
  }
  for (const d of (await db.collectionGroup('private').get()).docs) {
    if (d.id !== 'account') continue
    const uid = d.ref.parent.parent.id
    const before = d.get('pendingPhotoURLs') ?? []
    const after = [...mapPending(before, map, null), ...(playPending.get(uid) ?? [])]
    playPending.delete(uid)
    push(d.ref, { pendingPhotoURLs: before }, { pendingPhotoURLs: after }, 'account.pendingPhotoURLs', true)
  }
  for (const [uid, entries] of playPending) {
    updates.push({ path: `users/${uid}/private/account`, data: { pendingPhotoURLs: entries }, merge: true, note: 'account.pendingPhotoURLs (new)' })
  }
  for (const d of (await db.collectionGroup('likeQueue').get()).docs) {
    const lp = d.get('likerProfile')
    if (!lp || typeof lp !== 'object') continue
    const after = { ...lp, ...(lp.photoURL !== undefined && { photoURL: mapValue(lp.photoURL, map) }), ...(lp.photoURLs !== undefined && { photoURLs: mapList(lp.photoURLs, map) }) }
    push(d.ref, { likerProfile: lp }, { likerProfile: after }, 'likeQueue.likerProfile')
  }
  for (const d of (await db.collection('matches').get()).docs) {
    const snaps = d.get('participantSnapshots')
    if (!snaps || typeof snaps !== 'object') continue
    const after = Object.fromEntries(Object.entries(snaps).map(([k, s]) => [k, s && typeof s === 'object' && s.photoURL !== undefined ? { ...s, photoURL: mapValue(s.photoURL, map) } : s]))
    push(d.ref, { participantSnapshots: snaps }, { participantSnapshots: after }, 'matches.participantSnapshots')
  }
  for (const d of (await db.collection('reports').get()).docs) {
    const rs = d.get('reportedSnapshot')
    if (rs && typeof rs === 'object' && rs.photoURL !== undefined) push(d.ref, { reportedSnapshot: rs }, { reportedSnapshot: { ...rs, photoURL: mapValue(rs.photoURL, map) } }, 'reports.reportedSnapshot')
  }
  for (const d of (await db.collection('deletedAccounts').get()).docs) {
    if (d.get('photoURLs') !== undefined) push(d.ref, d.data(), { photoURLs: mapList(d.get('photoURLs'), map) }, 'deletedAccounts.photoURLs')
  }
  for (const d of (await db.collection('moderationLog').get()).docs) {
    if (d.get('photoUrl') !== undefined) push(d.ref, d.data(), { photoUrl: mapValue(d.get('photoUrl'), map) }, 'moderationLog.photoUrl')
  }
  return updates
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export async function copyObjects(bucket, moves) {
  for (const m of moves) {
    const dest = bucket.file(m.to)
    await bucket.file(m.from).copy(dest, { contentType: m.contentType, metadata: { zyloveCopy: '1' } })
    // Whatever the copy carried over: no download token on the new object.
    await dest.setMetadata({ metadata: { firebaseStorageDownloadTokens: null, zyloveCopy: '1' } })
    const [meta] = await dest.getMetadata()
    if (meta.metadata?.firebaseStorageDownloadTokens) throw new Error(`token still set on ${m.to}`)
  }
}

export async function writeDocs(db, FieldValue, updates) {
  for (let i = 0; i < updates.length; i += 400) {
    const batch = db.batch()
    for (const u of updates.slice(i, i + 400)) {
      const data = Object.fromEntries(Object.entries(u.data).map(([k, v]) => [k, v === '__DELETE__' ? FieldValue.delete() : v]))
      if (u.merge) batch.set(db.doc(u.path), data, { merge: true })
      else batch.update(db.doc(u.path), data)
    }
    await batch.commit()
  }
}

export async function deleteOriginals(bucket, moves) {
  for (const m of moves) await bucket.file(m.from).delete({ ignoreNotFound: true })
}

export async function migratePhotos({ db, bucket, FieldValue }) {
  const moves = await planObjects(bucket)
  const map = new Map(moves.map((m) => [m.from, m.to]))
  const updates = await planDocs(db, map)
  await copyObjects(bucket, moves)
  await writeDocs(db, FieldValue, updates)
  await deleteOriginals(bucket, moves)
  return { moves, updates }
}
