// Stage 1a: moves every non-profile field off users/{uid} into
// userInternal / private/{account,settings,identity} / userLocations, and
// turns users/{uid}.isAdmin into the `admin` auth claim. See scripts/lib/stage1a.mjs.
//
//   (cd functions && npm run build)                 field lists come from functions/lib
//   node scripts/migrate-stage1a.mjs --dry-run      what would move (field names only, no values)
//   node scripts/migrate-stage1a.mjs --apply        move it
//
// Run after the Stage 1a functions are deployed (they read the new homes and
// fall back to the root copies), before the rules that stop clients writing
// these fields. Idempotent: a second run finds nothing to move.
// Back up first (gcloud firestore export). Credentials: Application Default
// Credentials (gcloud auth application-default login).

import { createRequire } from 'node:module'
import { MOVED_FIELDS, isBotUid, loadExisting, planUser, applyPlan } from './lib/stage1a.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore')
const { getAuth } = require('firebase-admin/auth')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()
const deps = { db, auth: getAuth(), FieldValue, Timestamp }

const users = (await db.collection('users').get()).docs
const bots = users.filter((d) => isBotUid(d.id))
const people = users.filter((d) => !isBotUid(d.id))

const fieldCounts = new Map()
const homeCounts = { internal: 0, account: 0, settings: 0, identity: 0, location: 0 }
const markets = new Map()
let toScrub = 0
let deletedScrub = 0
const admins = []
const plans = []

for (const d of people) {
  const plan = planUser(d.id, d.data(), await loadExisting(db, d.id))
  plans.push(plan)
  for (const f of plan.onRoot) fieldCounts.set(f, (fieldCounts.get(f) ?? 0) + 1)
  if (plan.onRoot.length) toScrub++
  if (plan.deleted && plan.onRoot.length) deletedScrub++
  for (const k of Object.keys(plan.writes)) homeCounts[k]++
  if (plan.writes.location) markets.set(plan.writes.location.marketCityId ?? '(none)', (markets.get(plan.writes.location.marketCityId ?? '(none)') ?? 0) + 1)
  if (plan.admin) admins.push(d.id)
}

// Moved fields that also sit in the profile subdocs (reported only; Stage 2
// handles Play, and nothing private belongs in sparkProfile either).
const subFields = new Map()
for (const group of ['sparkProfile', 'playProfile']) {
  for (const d of (await db.collectionGroup(group).get()).docs) {
    if (isBotUid(d.ref.parent.parent?.id ?? '')) continue
    for (const f of MOVED_FIELDS) if (d.get(f) !== undefined) subFields.set(`${group}.${f}`, (subFields.get(`${group}.${f}`) ?? 0) + 1)
  }
}

console.log(`users: ${users.length} (${people.length} people, ${bots.length} bots skipped)`)
console.log(`\nRoot docs to scrub: ${toScrub} (of which deleted accounts: ${deletedScrub})`)
console.log('\nField                        docs')
for (const [f, n] of [...fieldCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(28)} ${n}`)
console.log('\nNew-home writes (docs):')
for (const [k, n] of Object.entries(homeCounts)) console.log(`  ${k.padEnd(10)} ${n}`)
console.log('\nLocked markets for migrated locations:')
for (const [m, n] of [...markets].sort((a, b) => b[1] - a[1])) console.log(`  ${m.padEnd(16)} ${n}`)
console.log(`\nAdmin claims to set: ${admins.length} (${admins.join(', ') || 'none'})`)
console.log('\nMoved fields still in profile subdocs (not changed by this script):')
if (subFields.size === 0) console.log('  none')
for (const [f, n] of subFields) console.log(`  ${f.padEnd(40)} ${n}`)

if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
let done = 0
for (const plan of plans) {
  if (!plan.onRoot.length && !Object.keys(plan.writes).length && !plan.admin) continue
  await applyPlan(deps, plan)
  done++
}
console.log(`\nApplied: ${done} users migrated.`)
