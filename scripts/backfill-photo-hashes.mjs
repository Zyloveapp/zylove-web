// T&S Phase 5: hash every existing profile photo once (perceptual hash —
// functions/src/photoHashCore.ts) and flag the same or near-same photo on two
// different accounts, as new uploads now do. Curated profiles are skipped.
//
//   node scripts/backfill-photo-hashes.mjs --dry-run   hashes in memory, counts and matches only
//   node scripts/backfill-photo-hashes.mjs --apply     writes photoHashes, photoDuplicates, signals
//
// Run `npm --prefix functions run build` first (it uses functions/lib).
// Back up Firestore before --apply. Prints counts and account ids only — no
// photos, names or personal data. Idempotent: an already-hashed photo is
// re-recorded with the same hash. Credentials: Application Default Credentials.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { getStorage } = require('firebase-admin/storage')
const { dHash, hamming, MAX_DISTANCE } = require('../functions/lib/photoHashCore.js')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove', storageBucket: 'zylove.firebasestorage.app' })
const { checkPhoto } = require('../functions/lib/photoHashes.js')

const [files] = await getStorage().bucket().getFiles({ prefix: 'photos/' })
const photos = files
  .map((f) => ({ f, m: f.name.match(/^photos\/([^/]+)\/(spark|play)\/[^/]+$/) }))
  .filter(({ m }) => m && !/^(zbot|seed)-/.test(m[1]))
let bytes = 0
const hashed = []
for (const { f, m } of photos) {
  const [buf] = await f.download()
  bytes += buf.length
  try {
    hashed.push({ uid: m[1], mode: m[2], path: f.name, hash: await dHash(buf), buf })
  } catch {
    console.log(`  skipped (not a readable image): 1 file`)
  }
}
const pairs = []
for (let i = 0; i < hashed.length; i++)
  for (let j = i + 1; j < hashed.length; j++)
    if (hashed[i].uid !== hashed[j].uid) {
      const d = hamming(hashed[i].hash, hashed[j].hash)
      if (d <= MAX_DISTANCE) pairs.push({ a: hashed[i].uid, b: hashed[j].uid, d })
    }
const accounts = new Set(hashed.map((h) => h.uid))
console.log(`Photos: ${photos.length} under photos/ (curated skipped); hashed: ${hashed.length}; accounts: ${accounts.size}; downloaded: ${(bytes / 1048576).toFixed(1)} MB`)
console.log(`Near-matches across different accounts (distance <= ${MAX_DISTANCE}): ${pairs.length}`)
for (const p of pairs) console.log(`  ${p.a} <-> ${p.b} (distance ${p.d})`)
const sameAccount = hashed.length - new Set(hashed.map((h) => `${h.uid}:${h.hash}`)).size
console.log(`Same photo reused within one account (not a match): ${sameAccount}`)

if (!apply) {
  console.log('Dry run — nothing written.')
  process.exit(0)
}
let flagged = 0
for (const h of hashed) {
  const r = await checkPhoto(h.uid, h.path, h.mode, h.buf)
  flagged += r.duplicates.length
}
console.log(`Applied: ${hashed.length} hashes written; duplicate links recorded: ${flagged}.`)
process.exit(0)
