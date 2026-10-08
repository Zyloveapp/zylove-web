// F-062 (private Play IDs) data migration. Used by scripts/migrate-f062.mjs
// and the regression suite (e2e/tests/25-play-ids.spec.mjs). Matthew,
// 2026-10-08: Play matches, messages, chat photos and Play likes are reset
// (deleted), not converted — none of the Play users are real; Play profiles
// and Play photos move to Play IDs.
//
//   every account with a Play profile (bots included)
//     • a Play ID (playIds/{uid} ↔ playIdOwners/{playId}; ensurePlayId)
//     • its Play photos copied to playPhotos/{playId}/{file} (marked as
//       server copies, so they aren't moderated again), and every reference
//       moved: playProfile/data.photoURLs and pending Play photos in
//       private/account. Bots' Play profiles share their Spark photos' paths
//       (photos/{botUid}/spark/…) — copied the same way, the Spark ones stay.
//       Their photo hashes follow them. The old files are NOT deleted: nothing
//       lists them any more, so getPhotoUrls never signs them; they're the
//       backup until a later cleanup.
//     • the public Play profile written (playProfiles/{playId})
//   reset:
//     • Play matches (matches/{id} with mode 'play' or 'entanglement'), with
//       their messages, typing, photo consent and chat photos, and the two
//       people's users/{uid}/matches/{id} entries
//     • Play likes: like-queue entries with mode 'play', pairs/{id}/likes/play,
//       pendingBotLikes with mode 'play'
//     • Play reveals left on pair docs ({uid}_revealed_play)
//
// Idempotent: a second run finds nothing to move or reset.

import { createHash } from 'node:crypto'

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [])
const hashId = (path) => createHash('sha256').update(path).digest('hex').slice(0, 32)
const baseName = (path) => path.split('/').pop()

// A stored photo reference that carries the uid: photos/{uid}/{mode}/{file}.
function ownPath(ref, uid) {
  return typeof ref === 'string' && new RegExp(`^photos/${uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(spark|play)/[^/]+$`).test(ref)
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export async function planF062({ db }) {
  const profiles = []
  const unmovable = []
  for (const d of (await db.collectionGroup('playProfile').get()).docs) {
    if (d.id !== 'data' || d.ref.parent.parent?.parent.id !== 'users') continue
    const uid = d.ref.parent.parent.id
    const published = strings(d.get('photoURLs'))
    const account = (await db.doc(`users/${uid}/private/account`).get()).data() ?? {}
    const pending = (Array.isArray(account.pendingPhotoURLs) ? account.pendingPhotoURLs : []).filter(
      (p) => p && typeof p.url === 'string' && (p.mode === 'play' || /\/play\//.test(p.url)),
    )
    const moves = [...published.filter((r) => ownPath(r, uid)), ...pending.map((p) => p.url).filter((r) => ownPath(r, uid))]
    unmovable.push(...published.filter((r) => r.includes(uid) && !ownPath(r, uid)).map(() => uid))
    profiles.push({ uid, bot: uid.startsWith('zbot-'), moves: [...new Set(moves)] })
  }

  const playMatches = (await db.collection('matches').where('mode', 'in', ['play', 'entanglement']).get()).docs
  let messages = 0
  const matchIndex = []
  for (const m of playMatches) {
    messages += (await m.ref.collection('messages').count().get()).data().count
    for (const u of strings(m.get('users') ?? m.get('participants'))) matchIndex.push(`users/${u}/matches/${m.id}`)
  }
  const likeQueue = (await db.collectionGroup('likeQueue').where('mode', '==', 'play').get()).docs.map((d) => d.ref.path)
  const pairLikes = (await db.collectionGroup('likes').get()).docs.filter((d) => d.id === 'play' && d.ref.parent.parent?.parent.id === 'pairs').map((d) => d.ref.path)
  const pendingBotLikes = (await db.collection('pendingBotLikes').where('mode', '==', 'play').get()).docs.map((d) => d.ref.path)
  const reveals = []
  for (const p of (await db.collection('pairs').get()).docs) {
    const fields = Object.keys(p.data()).filter((k) => k.endsWith('_revealed_play'))
    if (fields.length) reveals.push({ path: p.ref.path, fields })
  }
  return {
    profiles,
    unmovable,
    playMatches: playMatches.map((m) => m.id),
    messages,
    matchIndex,
    likeQueue,
    pairLikes,
    pendingBotLikes,
    reveals,
  }
}

export function summary(plan) {
  return {
    'Play profiles (accounts to get a Play ID)': plan.profiles.length,
    '  of which curated': plan.profiles.filter((p) => p.bot).length,
    'Play photos to copy to playPhotos/{playId}/': plan.profiles.reduce((n, p) => n + p.moves.length, 0),
    'Play photo references with the uid that can\'t be moved (URLs)': plan.unmovable.length,
    'Play matches to delete': plan.playMatches.length,
    '  their messages': plan.messages,
    '  match-index entries': plan.matchIndex.length,
    'Play likes in like queues to delete': plan.likeQueue.length,
    'pairs/*/likes/play to delete': plan.pairLikes.length,
    'pending Play bot like-backs to delete': plan.pendingBotLikes.length,
    'pair docs with Play reveals to clear': plan.reveals.length,
  }
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export async function applyF062({ db, bucket, FieldValue, ensurePlayId, refreshPlayProfile }, plan) {
  let writes = 0
  for (const p of plan.profiles) {
    const playId = await ensurePlayId(p.uid)
    const moved = new Map()
    for (const from of p.moves) {
      const to = `playPhotos/${playId}/${baseName(from)}`
      const src = bucket.file(from)
      if ((await src.exists())[0]) {
        // Marked as a server copy: onPhotoUpload doesn't moderate it again
        // (as scripts/lib/stage1b.mjs copies).
        const [meta] = await src.getMetadata()
        const dest = bucket.file(to)
        await src.copy(dest, { contentType: meta.contentType, metadata: { zyloveCopy: '1' } })
        await dest.setMetadata({ metadata: { firebaseStorageDownloadTokens: null, zyloveCopy: '1' } })
      }
      moved.set(from, to)
      // Its duplicate-photo hash follows it.
      const h = await db.doc(`photoHashes/${hashId(from)}`).get()
      if (h.exists) {
        await db.doc(`photoHashes/${hashId(to)}`).set({ ...h.data(), path: to })
        await h.ref.delete()
        writes += 2
      }
    }
    if (moved.size) {
      const playRef = db.doc(`users/${p.uid}/playProfile/data`)
      const cur = strings((await playRef.get()).get('photoURLs'))
      await playRef.update({ photoURLs: cur.map((r) => moved.get(r) ?? r) })
      const accRef = db.doc(`users/${p.uid}/private/account`)
      const pending = (await accRef.get()).get('pendingPhotoURLs')
      if (Array.isArray(pending) && pending.some((x) => moved.has(x?.url))) {
        await accRef.update({ pendingPhotoURLs: pending.map((x) => (moved.has(x?.url) ? { ...x, url: moved.get(x.url) } : x)) })
        writes++
      }
      writes++
    }
    await refreshPlayProfile(p.uid)
    writes++
  }

  // Reset: Play matches with everything in them.
  for (const id of plan.playMatches) {
    await db.recursiveDelete(db.doc(`matches/${id}`))
    await bucket.deleteFiles({ prefix: `chat-photos/${id}/` }).catch(() => {})
    writes++
  }
  const refs = [...plan.matchIndex, ...plan.likeQueue, ...plan.pairLikes, ...plan.pendingBotLikes].map((path) => db.doc(path))
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch()
    for (const r of refs.slice(i, i + 400)) batch.delete(r)
    await batch.commit()
  }
  writes += refs.length
  for (const r of plan.reveals) {
    await db.doc(r.path).update(Object.fromEntries(r.fields.map((f) => [f, FieldValue.delete()])))
    writes++
  }
  return writes
}
