// One-time backfill: flag bot matches so onBotMessage replies.
//
//   node scripts/fix-bot-matches.mjs --dry-run  report what would change
//   node scripts/fix-bot-matches.mjs            write the updates
//
// onBotMessage only replies on matches with isBot === true (its uid prefix
// fallback checks the legacy 'seed-', not 'zbot-'). Matches created by onLike
// or the web likeBack before 450bd53 lack the flag. Sets
// { isBot: true, botUid } on every match with a zbot- participant that isn't
// already flagged. Credentials: same as seed-sparks.mjs.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

// firebase-admin is already a dependency of the web functions codebase.
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

const PROJECT_ID = 'zylove'
const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const DRY_RUN = process.argv.includes('--dry-run')
const BATCH_LIMIT = 400

const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
console.log(`Credentials: ${existsSync(SERVICE_ACCOUNT) ? 'service account' : 'application default'}`)
console.log(DRY_RUN ? 'DRY RUN — nothing will be written\n' : 'LIVE RUN\n')

initializeApp({ credential, projectId: PROJECT_ID })
const db = getFirestore()

// Firestore can't prefix-match inside an array, so scan every match.
const snap = await db.collection('matches').get()

const found = []
for (const d of snap.docs) {
  const data = d.data()
  // 'participants' is the legacy name for 'users'.
  const users = Array.isArray(data.users) ? data.users : Array.isArray(data.participants) ? data.participants : []
  const botUid = users.find((u) => typeof u === 'string' && u.startsWith('zbot-'))
  if (botUid) found.push({ ref: d.ref, botUid, flagged: data.isBot === true })
}

const toUpdate = found.filter((m) => !m.flagged)
for (const m of toUpdate) console.log(`${DRY_RUN ? 'would update' : 'update'} ${m.ref.id}  botUid=${m.botUid}`)

if (!DRY_RUN) {
  for (let i = 0; i < toUpdate.length; i += BATCH_LIMIT) {
    const batch = db.batch()
    for (const m of toUpdate.slice(i, i + BATCH_LIMIT)) batch.update(m.ref, { isBot: true, botUid: m.botUid })
    await batch.commit()
  }
}

console.log(`\nScanned ${snap.size} matches`)
console.log(`Bot matches found: ${found.length} (${found.length - toUpdate.length} already flagged)`)
console.log(`${DRY_RUN ? 'Would update' : 'Updated'}: ${toUpdate.length}`)
