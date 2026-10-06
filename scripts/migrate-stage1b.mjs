// Stage 1b: profile photos move to new object names and every reference
// becomes a Storage path, so all old permanent links stop working (F-021);
// Play photos in review move to private/account (F-031). See
// scripts/lib/stage1b.mjs.
//
//   node scripts/migrate-stage1b.mjs --dry-run   counts only (no URLs, no values)
//   node scripts/migrate-stage1b.mjs --apply     move it
//
// Run after the Stage 1b functions are deployed (onPhotoUpload must skip
// zyloveCopy objects, getPhotoUrls must exist) and the client is live.
// Idempotent: a second run finds nothing to move. Back up Firestore first
// (gcloud firestore export); the original objects are deleted, so also copy
// photos/ aside (gsutil -m cp -r) before --apply.
// Credentials: Application Default Credentials.

import { createRequire } from 'node:module'
import { planObjects, planDocs, copyObjects, writeDocs, deleteOriginals } from './lib/stage1b.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove', storageBucket: 'zylove.firebasestorage.app' })
const db = getFirestore()
const bucket = getStorage().bucket()

const moves = await planObjects(bucket)
const map = new Map(moves.map((m) => [m.from, m.to]))
const updates = await planDocs(db, map)

const owners = new Set(moves.map((m) => m.from.split('/')[1]))
console.log(`Objects under photos/ to move: ${moves.length} (owners: ${owners.size}; with a download token: ${moves.filter((m) => m.hasToken).length})`)
console.log(`  spark: ${moves.filter((m) => m.from.includes('/spark/')).length}, play: ${moves.filter((m) => m.from.includes('/play/')).length}`)
const byNote = new Map()
for (const u of updates) byNote.set(u.note, (byNote.get(u.note) ?? 0) + 1)
console.log(`\nFirestore docs to rewrite: ${updates.length}`)
for (const [n, c] of [...byNote].sort((a, b) => b[1] - a[1])) console.log(`  ${n.padEnd(42)} ${c}`)
// References to photos/ files that don't exist any more (become plain paths).
const dangling = new Set()
for (const u of updates) {
  const walk = (v) => {
    if (typeof v === 'string' && v.startsWith('photos/') && !map.has(v) && ![...map.values()].includes(v)) dangling.add(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(u.data)
}
console.log(`\nReferences to photos no longer in Storage: ${dangling.size} (kept as paths; they resolve to nothing)`)

if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
console.log('\nCopying objects…')
await copyObjects(bucket, moves)
console.log('Rewriting Firestore…')
await writeDocs(db, FieldValue, updates)
console.log('Deleting originals…')
await deleteOriginals(bucket, moves)
console.log(`\nApplied: ${moves.length} objects moved, ${updates.length} docs rewritten.`)
