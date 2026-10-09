// Re-scores every pair with the current scoring engine (engine v2: see
// functions/src/legacy/scoring.ts SCORE_ENGINE_VERSION). Uses the deployed
// code's own per-pair step (rescorePair in legacy/onProfileWrite.ts), so it
// writes exactly what a live re-score does: the pair's Spark score,
// sparkEnoughInfo and engineVersion; the plan-gated details sub-docs; and the
// Play scores sub-doc. Also clears the flat 75s the retired botEngine left.
//
// Play pass (F-062/F-065): Play pair state lives in playPairData/{pA_pB},
// keyed by Play IDs — each is re-scored with the live Play engine while both
// people still have Play access, so stored Play labels (tier1Play) follow
// the current archetype rules.
//
//   (cd functions && npm run build)
//   node scripts/rescore-pairs.mjs --dry-run   old → new for every pair, the distribution, and label changes
//   node scripts/rescore-pairs.mjs --apply --backup <scratch>/rescore-backup.json
//
// --apply needs --backup: every doc it will rewrite (pairs/{id}, its
// modes/spark and modes/deep, playPairData/{id}) is saved there first. That
// is production data — a scratch path outside the repo, deleted after.
// Otherwise it prints only.
//
// Run --apply after the engine v2 functions are live (or onTap would serve
// v1 scores to clients that call it in between — harmless, it re-scores
// anything below the current engine version). Idempotent.
// Credentials: Application Default Credentials.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { writeFileSync } = require('node:fs')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
const backupAt = process.argv.includes('--backup') ? process.argv[process.argv.indexOf('--backup') + 1] : null
if (apply && !backupAt) {
  console.error('--apply needs --backup <scratch file>.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()

const { rescorePair, scoringDocs } = require('./lib/legacy/onProfileWrite.js')
const { SCORE_ENGINE_VERSION, calculatePlayScore } = require('./lib/legacy/scoring.js')
const { bothHavePlay, playFields, setPlayScores } = require('./lib/pairPlay.js')
const { isSuspendedUid } = require('./lib/userData.js')

// What the web app shows for a pair (src/services/discover.ts displayScore).
// Before (engine v1) it depended on the plan: Deep Fit for Elite and bot
// pairs, the base score otherwise. After (engine v2) every plan sees the same
// headline.
const BANDS = [[75, 'Strong fit'], [60, 'Good fit'], [0, 'Some differences']]
const label = (v) => BANDS.find(([min]) => v >= min)[1]
function shownV1(pair, deep) {
  const d = deep && typeof deep.combinedScore === 'number' && deep.combinedScore <= 100 && (deep.dataConfidence ?? 0) >= 0.6
  const v = d ? deep.combinedScore : pair.sparkScore
  return typeof v === 'number' ? Math.max(0, Math.min(100, Math.round(v))) : null
}
function shownV2(r) {
  return r.enoughInfo ? `${r.score} ${label(r.score)}` : 'Not enough info'
}

const pairs = (await db.collection('pairs').get()).docs
const playPairs = (await db.collection('playPairData').get()).docs
const archId = (t) => (t && typeof t === 'object' && t.archetype && typeof t.archetype === 'object' ? t.archetype.id ?? null : null)

// Everything --apply would rewrite, saved before the first write.
if (apply) {
  const backup = {}
  for (const snap of pairs) {
    backup[snap.ref.path] = snap.data()
    for (const m of ['spark', 'deep']) {
      const d = await db.doc(`pairs/${snap.id}/modes/${m}`).get()
      if (d.exists) backup[d.ref.path] = d.data()
    }
  }
  for (const snap of playPairs) backup[snap.ref.path] = snap.data()
  writeFileSync(backupAt, JSON.stringify(backup, null, 1))
  console.log(`Backed up ${Object.keys(backup).length} docs to ${backupAt}`)
}
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
    after: shownV2(r),
    dealbreakers: r.triggeredDealbreakers.join(','),
    headline: r.score,
    enoughInfo: r.enoughInfo,
    archBefore: archId(deep),
    archAfter: r.triggeredDealbreakers.length ? null : archId(r.tier1),
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
console.log('\nPair                                                   engine  before: plan (Elite) → after: every plan')
for (const r of rows) {
  console.log(`  ${r.pair.padEnd(52)} v${r.engine}   ${String(r.before).padStart(3)} (${String(r.beforeElite).padStart(3)}) → ${r.after}${r.dealbreakers ? `  [dealbreaker: ${r.dealbreakers}]` : ''}`)
}
function dist(name, xs) {
  xs = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!xs.length) return console.log(`  ${name}: none`)
  const q = (f) => xs[Math.round(f * (xs.length - 1))]
  const n = (f) => xs.filter(f).length
  console.log(`  ${name.padEnd(26)} n=${xs.length} min=${xs[0]} median=${q(0.5)} max=${xs.at(-1)}  90+: ${n((x) => x >= 90)}  100: ${n((x) => x >= 100)}  Strong(75+): ${n((x) => x >= 75)}  Good(60–74): ${n((x) => x >= 60 && x < 75)}  Some differences(<60): ${n((x) => x < 60)}`)
}
const num = (s) => (typeof s === 'string' && /^\d/.test(s) ? Number(s.split(' ')[0]) : s)
console.log('\nShown scores:')
dist('before (Free, non-bot)', rows.map((r) => r.before))
dist('before (Elite)', rows.map((r) => r.beforeElite))
dist('after (every plan)', rows.map((r) => num(r.after)))
console.log(`  after: Not enough info ${rows.filter((r) => !r.enoughInfo).length}; dealbreaker pairs ${rows.filter((r) => r.dealbreakers).length} (highest shown ${Math.max(0, ...rows.filter((r) => r.dealbreakers).map((r) => r.headline))})`)
const sparkChanged = rows.filter((r) => !r.bot && r.archBefore !== r.archAfter)
console.log(`\nSpark Deep Fit labels changed: ${sparkChanged.length} of ${rows.filter((r) => !r.bot).length} (non-bot pairs)`)
const tally = (xs) => Object.entries(xs.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')
console.log(`  ${tally(sparkChanged.map((r) => `${r.archBefore ?? 'none'} → ${r.archAfter ?? 'none'}`))}`)

// ─── Play pass ───────────────────────────────────────────────────────────────
const playRows = []
const playSkipped = []
for (const snap of playPairs) {
  const p = snap.data()
  const [a, b] = Array.isArray(p.users) ? p.users : []
  if (typeof a !== 'string' || typeof b !== 'string') {
    playSkipped.push(`${snap.id} (no users)`)
    continue
  }
  const [ma, mb] = await Promise.all([mine(a), mine(b)])
  if (!ma || !mb) {
    playSkipped.push(`${snap.id} (deleted or suspended)`)
    continue
  }
  if (!(await bothHavePlay(a, b))) {
    playSkipped.push(`${snap.id} (no Play access)`)
    continue
  }
  const r = calculatePlayScore(ma.full, mb.full)
  const bot = a.startsWith('zbot-') || b.startsWith('zbot-')
  playRows.push({ id: snap.id, bot, before: archId(p.tier1Play), after: archId(r.tier1), scoreBefore: p.playScore ?? null, scoreAfter: r.score })
  if (apply) await setPlayScores(a, b, { ...playFields(r.score, r.breakdown, r.tier1), engineVersion: SCORE_ENGINE_VERSION })
}
const playChanged = playRows.filter((r) => r.before !== r.after)
console.log(`\nPlay pairs: ${playPairs.length}; re-scored ${playRows.length}; skipped ${playSkipped.length}.`)
for (const s of playSkipped) console.log(`  skipped ${s}`)
console.log(`Play labels changed: ${playChanged.length} of ${playRows.length}; scores changed: ${playRows.filter((r) => r.scoreBefore !== r.scoreAfter).length}`)
console.log(`  ${tally(playChanged.map((r) => `${r.before ?? 'none'} → ${r.after ?? 'none'}`))}`)
console.log(apply ? `\nApplied: ${written} Spark pairs and ${playRows.length} Play pairs written.` : '\nDry run — nothing written.')
