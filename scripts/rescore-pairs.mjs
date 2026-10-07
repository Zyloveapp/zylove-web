// Re-scores every pair with the current scoring engine (engine v2: see
// functions/src/legacy/scoring.ts SCORE_ENGINE_VERSION). Uses the deployed
// code's own per-pair step (rescorePair in legacy/onProfileWrite.ts), so it
// writes exactly what a live re-score does: the pair's Spark score,
// sparkEnoughInfo and engineVersion; the plan-gated details sub-docs; and the
// Play scores sub-doc. Also clears the flat 75s the retired botEngine left.
//
//   (cd functions && npm run build)
//   node scripts/rescore-pairs.mjs --dry-run   old → new for every pair, and the distribution
//   node scripts/rescore-pairs.mjs --apply
//
// Run --apply after the engine v2 functions are live (or onTap would serve
// v1 scores to clients that call it in between — harmless, it re-scores
// anything below the current engine version). Idempotent.
// Credentials: Application Default Credentials.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()

const { rescorePair, scoringDocs } = require('./lib/legacy/onProfileWrite.js')
const { SCORE_ENGINE_VERSION } = require('./lib/legacy/scoring.js')
const { isSuspendedUid } = require('./lib/userData.js')

// What the web app shows for a pair (src/services/discover.ts displayScore),
// for a viewer who sees Deep Fit (Elite, or a bot pair) and one who doesn't.
const BANDS = [[75, 'Strong fit'], [60, 'Good fit'], [0, 'Some differences']]
const label = (v) => BANDS.find(([min]) => v >= min)[1]
function shownV1(pair, deep) {
  const d = deep && typeof deep.combinedScore === 'number' && deep.combinedScore <= 100 && (deep.dataConfidence ?? 0) >= 0.6
  const v = d ? deep.combinedScore : pair.sparkScore
  return typeof v === 'number' ? Math.max(0, Math.min(100, Math.round(v))) : null
}
function shownV2(r, deep) {
  if (!r.enoughInfo) return 'Not enough info'
  const v = Math.round(deep && r.tier1 ? r.tier1.combinedScore : r.score)
  return `${v} ${label(v)}`
}

const pairs = (await db.collection('pairs').get()).docs
const docs = new Map()
async function mine(uid) {
  if (!docs.has(uid)) {
    docs.set(uid, (async () => {
      const snap = await db.doc(`users/${uid}`).get()
      if (!snap.exists || snap.data().isDeleted === true || (await isSuspendedUid(uid, snap.data()))) return null
      return scoringDocs(uid, snap.data())
    })())
  }
  return docs.get(uid)
}

const rows = []
const skipped = []
let batch = apply ? db.batch() : null
let inBatch = 0
let written = 0
for (const snap of pairs) {
  const pair = snap.data()
  const me = await mine(pair.userA)
  if (!me) {
    skipped.push(`${snap.id} (${pair.userA} deleted or suspended)`)
    continue
  }
  const deep = (await db.doc(`pairs/${snap.id}/modes/deep`).get()).data()?.tier1Spark ?? pair.tier1Spark ?? null
  const r = await rescorePair(batch, snap, pair.userA, me)
  if (!r) {
    skipped.push(`${snap.id} (${pair.userB} gone)`)
    continue
  }
  const bot = pair.userA.startsWith('zbot-') || pair.userB.startsWith('zbot-')
  rows.push({
    pair: snap.id,
    bot,
    engine: pair.engineVersion ?? 1,
    before: shownV1(pair, bot ? deep : null),
    beforeElite: shownV1(pair, deep),
    after: shownV2(r, bot),
    afterElite: shownV2(r, true),
    dealbreakers: r.triggeredDealbreakers.join(','),
    newTier0: r.score,
    newDeep: r.tier1 ? +r.tier1.combinedScore.toFixed(1) : null,
    enoughInfo: r.enoughInfo,
  })
  if (batch && ++inBatch >= 100) {
    await batch.commit()
    written += inBatch
    batch = db.batch()
    inBatch = 0
  }
}
if (batch && inBatch) {
  await batch.commit()
  written += inBatch
}

console.log(`Pairs: ${pairs.length}; re-scored ${rows.length}; skipped ${skipped.length}. Engine → v${SCORE_ENGINE_VERSION}.`)
for (const s of skipped) console.log(`  skipped ${s}`)
console.log('\nPair                                                   engine  before(Elite) → after(Elite)')
for (const r of rows) {
  console.log(`  ${r.pair.padEnd(52)} v${r.engine}   ${String(r.before).padStart(3)} (${String(r.beforeElite).padStart(3)}) → ${r.after} (${r.afterElite})${r.dealbreakers ? `  [dealbreaker: ${r.dealbreakers}]` : ''}`)
}
function dist(name, xs) {
  xs = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!xs.length) return console.log(`  ${name}: none`)
  const q = (f) => xs[Math.round(f * (xs.length - 1))]
  const n = (f) => xs.filter(f).length
  console.log(`  ${name.padEnd(26)} n=${xs.length} min=${xs[0]} median=${q(0.5)} max=${xs.at(-1)}  90+: ${n((x) => x >= 90)}  100: ${n((x) => x >= 100)}  Strong(75+): ${n((x) => x >= 75)}  Good(60–74): ${n((x) => x >= 60 && x < 75)}  Some differences(<60): ${n((x) => x < 60)}`)
}
const num = (s) => (typeof s === 'string' && /^\d/.test(s) ? Number(s.split(' ')[0]) : s)
console.log('\nWhat Elite viewers (and bot pairs) see:')
dist('before', rows.map((r) => r.beforeElite))
dist('after', rows.map((r) => num(r.afterElite)))
console.log(`  after: Not enough info ${rows.filter((r) => !r.enoughInfo).length}; dealbreaker pairs ${rows.filter((r) => r.dealbreakers).length} (highest shown ${Math.max(0, ...rows.filter((r) => r.dealbreakers).map((r) => Math.max(r.newTier0, r.newDeep ?? 0)))})`)
console.log(apply ? `\nApplied: ${written} pairs written.` : '\nDry run — nothing written.')
