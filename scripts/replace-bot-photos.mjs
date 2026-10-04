// Replace bot photos with images you supply (e.g. AI-generated faces), hosted
// in our own Storage instead of hotlinked.
//
//   node scripts/replace-bot-photos.mjs --map=bot-photos.json --dry-run
//   node scripts/replace-bot-photos.mjs --map=bot-photos.json --apply
//
// bot-photos.json: { "zbot-w-001": ["https://…", "https://…", "https://…"], … }
// For each bot in the map: download every URL (images only, ≤ 10 MB), upload
// to Storage at bot-photos/{uid}/{index}.jpg with a download token, then set
// photoURLs on users/{uid} and users/{uid}/playProfile/data to those URLs.
// Bots not in the map are left alone. The dry run downloads and checks every
// image but writes nothing.
//
// Not photos/{uid}/spark/: uploads there run the mobile onPhotoUpload
// trigger, which would moderate them through Sightengine and append its own
// URLs to photoURLs (or queue them for admin review). Token URLs read
// without auth, so no Storage rule is needed. Credentials as in
// init-cities.mjs.

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')

const BUCKET = 'zylove.firebasestorage.app'
const MAX_BYTES = 10 * 1024 * 1024
const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const apply = process.argv.includes('--apply')
const mapArg = process.argv.find((a) => a.startsWith('--map='))?.slice('--map='.length)
if ((!apply && !process.argv.includes('--dry-run')) || !mapArg) {
  console.error('Usage: node scripts/replace-bot-photos.mjs --map=bot-photos.json (--dry-run | --apply)')
  process.exit(1)
}

const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
initializeApp({ credential, projectId: 'zylove', storageBucket: BUCKET })
const db = getFirestore()
const bucket = getStorage().bucket()

const mapping = JSON.parse(readFileSync(resolve(mapArg), 'utf8'))
const entries = Object.entries(mapping)
const problems = []
for (const [uid, urls] of entries) {
  if (!uid.startsWith('zbot-')) problems.push(`${uid}: not a bot uid`)
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => typeof u === 'string' && /^https:\/\//.test(u))) {
    problems.push(`${uid}: needs a non-empty list of https URLs`)
  }
}
if (problems.length) {
  console.error(`Mapping problems:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no content-type'})`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_BYTES) throw new Error(`too large (${bytes.length} bytes)`)
  return { bytes, type }
}

let done = 0
let failed = 0
for (const [uid, urls] of entries) {
  const userRef = db.doc(`users/${uid}`)
  if (!(await userRef.get()).exists) {
    console.log(`${uid}: no such user — skipped`)
    failed++
    continue
  }
  try {
    const images = []
    for (const url of urls) images.push(await download(url))
    const sizes = images.map((i) => `${Math.round(i.bytes.length / 1024)}KB`).join(', ')
    if (!apply) {
      console.log(`${uid}: would upload ${images.length} photos (${sizes})`)
      done++
      continue
    }
    const stored = []
    for (const [i, image] of images.entries()) {
      const path = `bot-photos/${uid}/${i}.jpg`
      const token = randomUUID()
      await bucket.file(path).save(image.bytes, {
        resumable: false,
        metadata: { contentType: image.type, cacheControl: 'public, max-age=31536000', metadata: { firebaseStorageDownloadTokens: token } },
      })
      stored.push(`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`)
    }
    await userRef.update({ photoURLs: stored })
    const playRef = db.doc(`users/${uid}/playProfile/data`)
    if ((await playRef.get()).exists) await playRef.update({ photoURLs: stored })
    console.log(`${uid}: ${stored.length} photos uploaded (${sizes})`)
    done++
  } catch (err) {
    console.log(`${uid}: FAILED — ${err instanceof Error ? err.message : String(err)}`)
    failed++
  }
}

console.log(`\n${entries.length} bots in map · ${done} ${apply ? 'replaced' : 'ready'} · ${failed} failed`)
if (!apply) console.log('Dry run — re-run with --apply to write.')
