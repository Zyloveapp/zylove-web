// Fits the display curves in functions/src/legacy/tier1/calibration.ts.
//
//   npm --prefix functions test && node scripts/calibrate-scores.mjs
//
// (npm test compiles functions/ and its tests into functions/.test-build.)
// The reference population is every compatible pair of the curated
// profiles in functions/test/fixtures/bots.json: complete, coherent profiles
// like real people's, unlike randomly assembled ones (which align less and
// would make real scores read high). The engines' raw scores (result.raw,
// before calibration) for pairs with full evidence and no dealbreaker are
// mapped from quantiles onto the targets below; paste the printed curves
// into calibration.ts and bump SCORE_ENGINE_VERSION. Reads nothing from
// production. Recalibrate on real users' pairs once there are enough.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { quantile } = require('./.test-build/test/population.js')
const { FULL_COVERAGE } = require('./.test-build/src/legacy/tier1/scorePair.js')
const { calculateSparkScore } = require('./.test-build/src/legacy/scoring.js')
const bots = require('./test/fixtures/bots.json')

// raw quantile → display score. Median 55; Strong fit (75+) ≈ top 15%;
// 95+ under 1% (the curve reaches 100 only at raw 100).
const TARGETS = [
  [0.02, 15],
  [0.1, 30],
  [0.3, 45],
  [0.5, 55],
  [0.7, 64],
  [0.85, 75],
  [0.95, 85],
]

const t0 = []
const t1 = []
for (let i = 0; i < bots.length; i++) {
  for (let j = i + 1; j < bots.length; j++) {
    const r = calculateSparkScore(bots[i], bots[j])
    if (r.raw.tier0 === 0 || !r.enoughInfo || r.triggeredDealbreakers.length || !r.tier1 || r.tier1.coverage < FULL_COVERAGE) continue
    t0.push(r.raw.tier0)
    t1.push(r.raw.tier1)
  }
}

function fit(name, xs) {
  xs.sort((a, b) => a - b)
  const points = [[0, 0]]
  for (const [q, y] of TARGETS) {
    const x = +quantile(xs, q).toFixed(1)
    if (x > points.at(-1)[0] && y > points.at(-1)[1]) points.push([x, y])
  }
  points.push([100, 100])
  console.log(`${name} (n=${xs.length}): raw p2=${quantile(xs, 0.02).toFixed(1)} p50=${quantile(xs, 0.5).toFixed(1)} p95=${quantile(xs, 0.95).toFixed(1)} max=${xs.at(-1).toFixed(1)}`)
  console.log(`  [${points.map(([x, y]) => `[${x}, ${y}]`).join(', ')}]`)
}
fit('TIER1_CURVE', t1)
fit('TIER0_CURVE', t0)
