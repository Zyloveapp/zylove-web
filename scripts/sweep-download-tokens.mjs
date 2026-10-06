// Removes every Firebase download token from the bucket (see
// scripts/lib/tokenSweep.mjs): mobile-era and bot photos move into the photo
// model, unreferenced ones are deleted, everything else just loses its token.
//
//   node scripts/sweep-download-tokens.mjs --dry-run
//   node scripts/sweep-download-tokens.mjs --apply        copy, rewrite, strip (plan saved)
//   node scripts/sweep-download-tokens.mjs --delete       delete originals + unreferenced (from the saved plan)
//   node scripts/sweep-download-tokens.mjs --count        objects still carrying a token
//
// Run after the getReviewPdfUrl client is live. Back up first (Firestore
// export + a token-free copy of the affected files).
// Credentials: Application Default Credentials.

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { planSweep, applySweep, deleteSwept, countTokens } from './lib/tokenSweep.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')

const mode = ['--dry-run', '--apply', '--delete', '--count'].find((a) => process.argv.includes(a))
if (!mode) {
  console.error('Pass --dry-run, --apply, --delete or --count.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove', storageBucket: 'zylove.firebasestorage.app' })
const db = getFirestore()
const bucket = getStorage().bucket()
const PLAN = new URL('./.token-sweep-plan.json', import.meta.url).pathname

if (mode === '--count') {
  const { total, withToken } = await countTokens(bucket)
  const byPrefix = new Map()
  for (const n of withToken) byPrefix.set(n.split('/')[0], (byPrefix.get(n.split('/')[0]) ?? 0) + 1)
  console.log(`objects: ${total}, with a download token: ${withToken.length}`, Object.fromEntries(byPrefix))
  process.exit(0)
}
if (mode === '--delete') {
  const plan = JSON.parse(readFileSync(PLAN, 'utf8'))
  for (const m of plan.moves) if (!(await bucket.file(m.to).exists())[0]) throw new Error(`copy missing for ${m.from} — nothing deleted`)
  await deleteSwept(bucket, plan)
  console.log(`deleted ${plan.moves.length} moved originals and ${plan.deletes.length} unreferenced files`)
  process.exit(0)
}

const plan = await planSweep(db, bucket)
const prefix = (n) => n.split('/')[0]
const tally = (list) => list.reduce((t, n) => ({ ...t, [prefix(n)]: (t[prefix(n)] ?? 0) + 1 }), {})
console.log(`move into photos/: ${plan.moves.length}`, tally(plan.moves.map((m) => m.from)), `(spark ${plan.moves.filter((m) => m.to.includes('/spark/')).length}, play ${plan.moves.filter((m) => m.to.includes('/play/')).length})`)
console.log(`delete (unreferenced): ${plan.deletes.length}`, tally(plan.deletes))
console.log(`strip token, keep path: ${plan.strips.length}`, tally(plan.strips))
const byNote = new Map()
for (const u of plan.updates) byNote.set(u.note, (byNote.get(u.note) ?? 0) + 1)
console.log(`Firestore docs to rewrite: ${plan.updates.length}`, Object.fromEntries(byNote))
if (mode === '--dry-run') {
  console.log('Dry run — nothing written.')
  process.exit(0)
}
if (existsSync(PLAN)) throw new Error(`${PLAN} exists — --apply already ran; use --delete`)
writeFileSync(PLAN, JSON.stringify({ moves: plan.moves, deletes: plan.deletes, strips: plan.strips }))
await applySweep({ db, bucket, FieldValue }, plan)
console.log('Applied: copies made, references rewritten, tokens stripped. Originals kept until --delete.')
