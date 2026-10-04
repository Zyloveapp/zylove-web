// Temporary: cut every bot (zbot-* user) down to its first photo, on the
// root doc and playProfile/data. Interim step until replace-bot-photos.mjs
// swaps the Unsplash portraits for AI-generated ones.
//
//   node scripts/strip-bot-photos.mjs --dry-run
//   node scripts/strip-bot-photos.mjs --apply
//
// Only shortens photoURLs; never adds or reorders. Credentials as in
// init-cities.mjs.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { FieldPath, getFirestore } = require('firebase-admin/firestore')

const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply')
  process.exit(1)
}
const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
initializeApp({ credential, projectId: 'zylove' })
const db = getFirestore()

const list = (v) => (Array.isArray(v) ? v.filter((u) => typeof u === 'string' && u) : [])

// '.' sorts right after '-', so this range is exactly the zbot- ids.
const bots = await db
  .collection('users')
  .where(FieldPath.documentId(), '>=', 'zbot-')
  .where(FieldPath.documentId(), '<', 'zbot.')
  .get()

let rootChanged = 0
let playChanged = 0
let removed = 0
let kept = 0
for (const bot of bots.docs) {
  const root = list(bot.data().photoURLs)
  const playRef = bot.ref.collection('playProfile').doc('data')
  const playSnap = await playRef.get()
  const play = playSnap.exists ? list(playSnap.data().photoURLs) : null

  const notes = []
  if (root.length > 1) {
    rootChanged++
    removed += root.length - 1
    notes.push(`root ${root.length}→1`)
    if (apply) await bot.ref.update({ photoURLs: root.slice(0, 1) })
  }
  if (play && play.length > 1) {
    playChanged++
    notes.push(`play ${play.length}→1`)
    if (apply) await playRef.update({ photoURLs: play.slice(0, 1) })
  }
  if (root.length > 0) kept++
  console.log(`${bot.id}: ${notes.length ? notes.join(', ') : 'already 1 or fewer'}`)
}

console.log(
  `\n${bots.size} bots · ${apply ? 'stripped' : 'would strip'} ${rootChanged} root docs + ${playChanged} Play profiles · ` +
    `${removed} root photo slots removed · ${kept} bots keep 1 photo`,
)
if (!apply) console.log('Dry run — re-run with --apply to write.')
