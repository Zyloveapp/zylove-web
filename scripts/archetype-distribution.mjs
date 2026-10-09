// How often each Deep Fit archetype is shown, across real pairs. Read-only.
//
//   (cd functions && npm run build)
//   node scripts/archetype-distribution.mjs --dump <scratch>/profiles.json
//       reads every live user's scoring docs from production (the same docs
//       onTap scores: scoringDocs → root + private/profile + private/matching,
//       plus the Play profile) and writes them to the given file. Production
//       data: write it to a scratch directory, never the repo; delete it after.
//   node scripts/archetype-distribution.mjs --measure <scratch>/profiles.json [--json out.json]
//       runs the built scoring engine (functions/lib) over every pair of
//       those users, offline: Spark (calculateSparkScore) and Play
//       (calculatePlayScore), and prints how often each archetype is shown.
//       Build functions/lib from the branch you want to measure.
//
// Populations:
//   spark — every pair that could meet in Spark (mutual attraction: a
//           non-zero headline), both with a Spark profile
//   pairs — the subset with a stored pairs/{id} doc (pairs people actually
//           opened, liked or were matched)
//   play  — every pair with a finished Play profile on both sides, at
//           least one a real member; playAll adds curated × curated (a
//           larger sample of realistic profiles; they never meet)
// "Shown" mirrors the app: an archetype appears only with enough info, no
// dealbreaker and confidence > 0.4 (CompatibilityBlock / MatchOverlay).
// Credentials (--dump): Application Default Credentials.

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

if (flag('--dump')) {
  const { initializeApp, applicationDefault } = require('firebase-admin/app')
  const { getFirestore } = require('firebase-admin/firestore')
  initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
  const db = getFirestore()
  const { scoringDocs } = require('./lib/legacy/onProfileWrite.js')
  const { isSuspendedUid } = require('./lib/userData.js')
  const users = (await db.collection('users').get()).docs
  const out = []
  for (const snap of users) {
    const d = snap.data()
    const bot = /^(zbot|seed)-/.test(snap.id) || d.isBot === true
    // Curated profiles never set onboardingComplete; they're in Explore anyway.
    if (d.isDeleted === true || (!bot && d.onboardingComplete !== true)) continue
    if (await isSuspendedUid(snap.id, d)) continue
    const docs = await scoringDocs(snap.id, d)
    out.push({ uid: snap.id, bot, spark: docs.spark, full: docs.full })
  }
  const pairIds = (await db.collection('pairs').select().get()).docs.map((p) => p.id)
  writeFileSync(flag('--dump'), JSON.stringify({ users: out, pairIds }))
  console.log(`dumped ${out.length} users, ${pairIds.length} pair ids → ${flag('--dump')}`)
  process.exit(0)
}

const file = flag('--measure')
if (!file) {
  console.error('Pass --dump <file> or --measure <file>.')
  process.exit(1)
}
const { calculateSparkScore, calculatePlayScore } = require('./lib/legacy/scoring.js')
const { users, pairIds } = JSON.parse(readFileSync(file, 'utf8'))
const stored = new Set(pairIds)
const sorted = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`)

const tally = () => ({ total: 0, counts: {} })
const add = (t, key) => {
  t.total++
  t.counts[key] = (t.counts[key] ?? 0) + 1
}
const out = { spark: tally(), pairs: tally(), sparkReal: tally(), sparkAll: tally(), play: tally(), playAll: tally() }

const hasSpark = (u) => Array.isArray(u.spark.photoURLs) || typeof u.spark.genderIdentity === 'string'
const hasPlay = (u) => u.full.playOnboardingComplete === true

for (let i = 0; i < users.length; i++) {
  for (let j = i + 1; j < users.length; j++) {
    const a = users[i]
    const b = users[j]
    // Curated profiles never meet each other; their pairs are counted only in
    // sparkAll, a larger sample of realistic profiles.
    const botPair = a.bot && b.bot
    if (hasSpark(a) && hasSpark(b)) {
      const r = calculateSparkScore(a.spark, b.spark)
      if (r.score > 0) {
        const t1 = r.tier1
        const key = !r.enoughInfo
          ? '(not enough info)'
          : r.triggeredDealbreakers?.length > 0
            ? '(dealbreaker)'
            : t1?.archetype && t1.archetype.confidence > 0.4
              ? t1.archetype.id
              : '(neutral: no archetype)'
        add(out.sparkAll, key)
        if (botPair) continue
        add(out.spark, key)
        if (!a.bot && !b.bot) add(out.sparkReal, key)
        if (stored.has(sorted(a.uid, b.uid))) add(out.pairs, key)
      }
    }
    if (hasPlay(a) && hasPlay(b)) {
      const key = calculatePlayScore(a.full, b.full).tier1?.archetype?.id ?? '(none)'
      add(out.playAll, key)
      if (!botPair) add(out.play, key)
    }
  }
}

function table(name, t) {
  const rows = Object.entries(t.counts).sort((x, y) => y[1] - x[1])
  console.log(`\n${name} — ${t.total} pairs`)
  for (const [k, n] of rows) console.log(`  ${k.padEnd(28)} ${String(n).padStart(6)}  ${((100 * n) / Math.max(1, t.total)).toFixed(1)}%`)
  // Among pairs that show something (enough info, no dealbreaker).
  const shown = rows.filter(([k]) => !k.startsWith('(not enough') && !k.startsWith('(dealbreaker'))
  const base = shown.reduce((s, [, n]) => s + n, 0)
  if (base && !name.startsWith('play')) {
    console.log(`  — of the ${base} pairs with enough info and no dealbreaker:`)
    for (const [k, n] of shown) console.log(`    ${k.padEnd(26)} ${((100 * n) / base).toFixed(1)}%`)
  }
}
console.log(`${users.length} users (${users.filter((u) => u.bot).length} curated)`)
table('spark (all pairs that could meet)', out.spark)
table('spark (real member pairs only)', out.sparkReal)
table('pairs (stored pair docs)', out.pairs)
table('spark, all pairs incl. curated × curated (larger sample)', out.sparkAll)
table('play', out.play)
table('play, all pairs incl. curated × curated (larger sample)', out.playAll)
if (flag('--json')) writeFileSync(flag('--json'), JSON.stringify(out, null, 2))
