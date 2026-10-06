// Stage 3: matching preferences and account state off the public user doc,
// Explore index and already-seen state built. See scripts/lib/stage3.mjs.
//
//   (cd functions && npm run build)
//   node scripts/migrate-stage3.mjs --dry-run      counts only (no values)
//   node scripts/migrate-stage3.mjs --index-only   phase 1: Explore index + already-seen state (moves nothing)
//   node scripts/migrate-stage3.mjs --apply        phase 2: the moves, then the index rebuilt
//
// Phase 1 after the Stage 3 functions are live and before the client push
// (the new Explore reads the index); phase 2 after the client push, before
// the final rules. Idempotent. Back up first. Credentials: Application
// Default Credentials.

import { createRequire } from 'node:module'
import { planStage3, applyStage3, applyStage3IndexOnly } from './lib/stage3.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')

const apply = process.argv.includes('--apply')
const indexOnly = process.argv.includes('--index-only')
if (!apply && !indexOnly && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run, --index-only or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove', storageBucket: 'zylove.firebasestorage.app' })
const db = getFirestore()
const { buildEntry } = require(new URL('../functions/lib/explore.js', import.meta.url).pathname)

const plan = await planStage3(db)
const fieldCounts = new Map()
for (const u of plan.users) for (const f of u.scrub) fieldCounts.set(f, (fieldCounts.get(f) ?? 0) + 1)
console.log(`users: ${plan.indexUids.length}`)
for (const [k, n] of Object.entries(plan.counts)) console.log(`  ${k.padEnd(48)} ${n}`)
console.log('\nPublic-doc fields to remove                      docs')
for (const [f, n] of [...fieldCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(48)} ${n}`)
if (indexOnly) {
  const r = await applyStage3IndexOnly({ db }, plan, buildEntry)
  console.log(`\nPhase 1 applied: ${r.writes} already-seen docs; explore index entries: ${r.indexed}.`)
  process.exit(0)
}
if (!apply) {
  // Who would be discoverable, without writing the index.
  let spark = 0, play = 0, none = 0
  for (const uid of plan.indexUids) {
    const e = await buildEntry(uid).catch(() => null)
    if (!e) none++
    else {
      if (e.sparkActive) spark++
      if (e.playActive) play++
    }
  }
  console.log(`\nExplore index (from today's data): Spark-active ${spark}, Play-active ${play}, not discoverable ${none}`)
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
const r = await applyStage3({ db, FieldValue }, plan, buildEntry)
console.log(`\nApplied: ${r.writes} writes; explore index entries: ${r.indexed}.`)
