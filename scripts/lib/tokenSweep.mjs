// Download-token sweep (F-021 / F-033 follow-up). Used by
// scripts/sweep-download-tokens.mjs and the regression suite.
//
// A Firebase download token makes a file readable by anyone with the link,
// forever, whatever the Storage rules say. After this, no object in the
// bucket carries one:
//
//   • photos referenced from Firestore by a token URL outside photos/ —
//     mobile-era users/{uid}/photos/… and the bots' bot-photos/{uid}/… — move
//     into the photo model: copied to photos/{uid}/{spark|play}/{new name}
//     (spark when a root doc references it, else play), every reference
//     rewritten to the new path (scripts/lib/stage1b.mjs planDocs), and the
//     originals deleted
//   • unreferenced files under those two prefixes are deleted
//   • everything else (review PDFs, anything left) keeps its path and just
//     loses its token
//
// Back up first (Firestore export + a token-free copy of the files).

import { randomUUID } from 'node:crypto'
import { pathOf, planDocs, writeDocs } from './stage1b.mjs'

const MOVE_PREFIXES = [/^users\/([^/]+)\/photos\/[^/]+$/, /^bot-photos\/([^/]+)\/.+$/]
const ownerOf = (path) => MOVE_PREFIXES.map((re) => re.exec(path)).find(Boolean)?.[1] ?? null

// Every Storage path a profile-photo field references, and where from.
async function referencedPaths(db) {
  const refs = new Map() // path → Set('root' | 'play' | 'other')
  const add = (v, where) => {
    const p = pathOf(v)
    if (!p) return
    refs.set(p, (refs.get(p) ?? new Set()).add(where))
  }
  const walk = (v, where) => {
    if (typeof v === 'string') add(v, where)
    else if (Array.isArray(v)) v.forEach((x) => walk(x, where))
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, where))
  }
  for (const d of (await db.collection('users').get()).docs) walk(d.get('photoURLs'), 'root')
  for (const d of (await db.collectionGroup('playProfile').get()).docs) walk(d.get('photoURLs'), 'play')
  for (const g of ['sparkProfile', 'likeQueue', 'private']) for (const d of (await db.collectionGroup(g).get()).docs) walk(d.data(), 'other')
  for (const c of ['matches', 'reports', 'deletedAccounts', 'moderationLog']) for (const d of (await db.collection(c).get()).docs) walk(d.data(), 'other')
  return refs
}

export async function planSweep(db, bucket) {
  const [files] = await bucket.getFiles()
  const refs = await referencedPaths(db)
  const moves = [] // { from, to, contentType }
  const deletes = [] // unreferenced mobile-era / bot files
  const strips = [] // keep path, drop token
  for (const f of files) {
    const hasToken = !!f.metadata?.metadata?.firebaseStorageDownloadTokens
    const owner = ownerOf(f.name)
    if (owner) {
      const where = refs.get(f.name)
      if (!where) {
        deletes.push(f.name)
        continue
      }
      const mode = where.has('root') || !where.has('play') ? 'spark' : 'play'
      const ext = f.name.includes('.') ? f.name.split('.').pop().toLowerCase() : 'jpg'
      moves.push({ from: f.name, to: `photos/${owner}/${mode}/${Date.now()}-${randomUUID().slice(0, 12)}.${ext}`, contentType: f.metadata?.contentType ?? 'image/jpeg' })
    } else if (hasToken) {
      strips.push(f.name)
    }
  }
  const map = new Map(moves.map((m) => [m.from, m.to]))
  const updates = await planDocs(db, map)
  return { moves, deletes, strips, updates, map }
}

export async function applySweep({ db, bucket, FieldValue }, plan) {
  for (const m of plan.moves) {
    const dest = bucket.file(m.to)
    await bucket.file(m.from).copy(dest, { contentType: m.contentType, metadata: { zyloveCopy: '1' } })
    await stripToken(dest)
  }
  await writeDocs(db, FieldValue, plan.updates)
  for (const p of plan.strips) await stripToken(bucket.file(p))
}

// Rewrites the file in place (same path, bytes and content type; other
// custom metadata kept) without its download token, then checks.
async function stripToken(file) {
  const [meta] = await file.getMetadata()
  const { firebaseStorageDownloadTokens, ...custom } = meta.metadata ?? {}
  if (firebaseStorageDownloadTokens) {
    const [bytes] = await file.download()
    await file.save(bytes, { resumable: false, contentType: meta.contentType, metadata: { cacheControl: meta.cacheControl, metadata: custom } })
  }
  if ((await file.getMetadata())[0].metadata?.firebaseStorageDownloadTokens) throw new Error(`token still set on ${file.name}`)
}

// After checking the moved photos display: originals and unreferenced files go.
export async function deleteSwept(bucket, plan) {
  for (const p of [...plan.moves.map((m) => m.from), ...plan.deletes]) await bucket.file(p).delete({ ignoreNotFound: true })
}

export async function countTokens(bucket) {
  const [files] = await bucket.getFiles()
  const withToken = files.filter((f) => f.metadata?.metadata?.firebaseStorageDownloadTokens)
  return { total: files.length, withToken: withToken.map((f) => f.name) }
}
