// F-062 (private Play IDs): Play IDs for every Play profile, Play photos
// moved to playPhotos/{playId}/, the public Play profiles written, and Play
// matches, messages, chat photos and likes reset. See scripts/lib/f062.mjs.
//
//   (cd functions && npm run build)               uses functions/lib (playIds, playProfiles)
//   node scripts/migrate-f062.mjs --dry-run       counts only (no names, ids or content)
//   node scripts/migrate-f062.mjs --apply
//
// Run after the F-062 functions, client and rules are live. Idempotent.
// Back up first (Firestore export); no Storage file is deleted except chat
// photos of the reset Play matches. Credentials: Application Default
// Credentials.

import { createRequire } from 'node:module'
import { applyF062, planF062, summary } from './lib/f062.mjs'

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
const { ensurePlayId } = require('../functions/lib/playIds.js')
const { refreshPlayProfile } = require('../functions/lib/playProfiles.js')

const plan = await planF062({ db })
for (const [k, n] of Object.entries(summary(plan))) console.log(`${k.padEnd(64)} ${n}`)
if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
const n = await applyF062({ db, bucket: getStorage().bucket(), FieldValue, ensurePlayId, refreshPlayProfile }, plan)
console.log(`\nApplied: ${n} writes.`)
process.exit(0)
