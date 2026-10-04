// Bot photos from local AI-generated images: one photo per Austin bot,
// replacing the hotlinked Unsplash portraits.
//
//   node scripts/uploadBotPhotos.mjs --dry-run
//   node scripts/uploadBotPhotos.mjs --apply
//
// ~/Desktop/Zylove/bot-photos/compressed/women/women-N.jpg → zbot-w-00N (N = 1…20)
// ~/Desktop/Zylove/bot-photos/compressed/men/men-N.jpg     → zbot-m-00N (N = 1…20)
// women-21 / men-21 are spares and never used.
//
// Each image goes to Storage at bot-photos/{uid}/1.jpg with a download
// token; users/{uid}.photoURLs and users/{uid}/playProfile/data.photoURLs
// become [that URL]. Not photos/{uid}/…: uploads there run the mobile
// onPhotoUpload trigger (Sightengine moderation, which would also append its
// own URLs or queue the bot for admin review). Token URLs read without auth,
// so no Storage rule is needed.
//
// The dry run checks every file (JPEG signature, dimensions, size, no two
// bots sharing an identical image) and every bot doc, and writes nothing.
// Credentials: Application Default Credentials (gcloud auth
// application-default login).

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')

const BUCKET = 'zylove.firebasestorage.app'
const PHOTO_DIR = join(homedir(), 'Desktop/Zylove/bot-photos/compressed')
const BOTS_PER_SIDE = 20
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
const MIN_BYTES = 20 * 1024 // anything smaller isn't a real portrait

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply')
  process.exit(1)
}

initializeApp({ credential: applicationDefault(), projectId: 'zylove', storageBucket: BUCKET })
const db = getFirestore()
const bucket = getStorage().bucket()

const mapping = []
for (const [side, prefix] of [
  ['women', 'w'],
  ['men', 'm'],
]) {
  for (let n = 1; n <= BOTS_PER_SIDE; n++) {
    mapping.push({ uid: `zbot-${prefix}-${String(n).padStart(3, '0')}`, file: join(PHOTO_DIR, side, `${side}-${n}.jpg`) })
  }
}

// Width × height from the first start-of-frame marker (SOF0–SOF15, not the
// DHT/JPG/DAC markers C4, C8, CC), or null if there isn't one.
function jpegSize(bytes) {
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]
    const length = bytes.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)]
    }
    i += 2 + length
  }
  return null
}

// ─── Check every file and bot first; nothing is written unless all pass ─────

const problems = []
const seenHashes = new Map()
for (const m of mapping) {
  const name = m.file.slice(PHOTO_DIR.length + 1)
  if (!existsSync(m.file)) {
    problems.push(`${name}: missing`)
    continue
  }
  const bytes = readFileSync(m.file)
  m.bytes = bytes
  m.name = name
  if (!bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) problems.push(`${name}: not a JPEG`)
  else {
    const size = jpegSize(bytes)
    if (!size) problems.push(`${name}: can't read JPEG dimensions`)
    else [m.width, m.height] = size
  }
  if (bytes.length < MIN_BYTES) problems.push(`${name}: only ${bytes.length} bytes`)
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (seenHashes.has(hash)) problems.push(`${name}: identical to ${seenHashes.get(hash)}`)
  seenHashes.set(hash, name)

  const user = await db.doc(`users/${m.uid}`).get()
  if (!user.exists) problems.push(`${m.uid}: no such user`)
  m.currentPhotos = Array.isArray(user.data()?.photoURLs) ? user.data().photoURLs.length : 0
  m.hasPlay = (await db.doc(`users/${m.uid}/playProfile/data`).get()).exists
}

for (const m of mapping) {
  if (!m.bytes) continue
  const kb = Math.round(m.bytes.length / 1024)
  console.log(
    `${apply ? 'upload' : 'would upload'} ${m.name.padEnd(16)} → ${m.uid}  ${String(kb).padStart(5)} KB  ${m.width}×${m.height}  ` +
      `(now ${m.currentPhotos} photo${m.currentPhotos === 1 ? '' : 's'}${m.hasPlay ? ', + Play profile' : ', no Play profile'})`,
  )
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s) — nothing written:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}

const totalMb = (mapping.reduce((s, m) => s + m.bytes.length, 0) / 1024 / 1024).toFixed(1)
if (!apply) {
  console.log(
    `\nAll ${mapping.length} files present, valid JPEGs, no duplicates (${totalMb} MB). ` +
      `${mapping.length} bots would go to 1 photo: ${mapping.filter((m) => m.hasPlay).length} with a Play profile too.`,
  )
  console.log('Dry run — nothing written. Re-run with --apply.')
  process.exit(0)
}

// ─── Apply ───────────────────────────────────────────────────────────────────

let done = 0
for (const m of mapping) {
  const path = `bot-photos/${m.uid}/1.jpg`
  const token = randomUUID()
  await bucket.file(path).save(m.bytes, {
    resumable: false,
    metadata: {
      contentType: 'image/jpeg',
      cacheControl: 'public,max-age=31536000',
      metadata: { firebaseStorageDownloadTokens: token },
    },
  })
  const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`
  await db.doc(`users/${m.uid}`).update({ photoURLs: [url] })
  if (m.hasPlay) await db.doc(`users/${m.uid}/playProfile/data`).update({ photoURLs: [url] })
  done++
  console.log(`  ${m.uid}: done`)
}
console.log(`\n${done} bots updated (${totalMb} MB uploaded).`)
