// Privacy-policy retention, read-only: per collection, how many docs there
// are, how many are past the cutoff, and of those how many purgeRetention
// would delete, leaves as protected (open/held/locker reports, unmirrored
// blocks), or can't date. Runs the same table and code as the scheduled
// job (functions/src/retention.ts, via functions/lib) in dry-run mode —
// nothing is written. Counts only (no ids or personal data).
//
//   (cd functions && npm run build)           uses functions/lib/retention.js
//   node scripts/retention-dry-run.mjs
//
// Real deletes stay off until config/retention { enabled: true } is set
// (Firestore console) after these counts are OK'd. Credentials: Application
// Default Credentials.

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/retention-dry-run.mjs   (read-only; build functions first)')
  process.exit(0)
}
const lib = new URL('../functions/lib/retention.js', import.meta.url)
if (!existsSync(lib)) {
  console.error('functions/lib/retention.js not found — run (cd functions && npm run build) first.')
  process.exit(1)
}
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { RETENTION, runRetention } = require(fileURLToPath(lib))

let counts
try {
  initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
  counts = await runRetention(Date.now(), true)
} catch (err) {
  console.error(`Dry run failed (credentials? try gcloud auth application-default login): ${err.message ?? err}`)
  process.exit(1)
}
const days = (ms) => `${Math.round(ms / 86400000)}d`
console.log(`${'collection'.padEnd(22)}${'max age'.padEnd(9)}${'total'.padStart(8)}${'older'.padStart(8)}${'would delete'.padStart(14)}${'protected'.padStart(11)}${'undated'.padStart(9)}`)
for (const e of RETENTION) {
  const c = counts[e.collection]
  console.log(`${e.collection.padEnd(22)}${days(e.maxAgeMs).padEnd(9)}${String(c.total).padStart(8)}${String(c.older).padStart(8)}${String(c.wouldDelete).padStart(14)}${String(c.skippedProtected).padStart(11)}${String(c.skippedUndated).padStart(9)}`)
}
console.log('\nDry run — nothing deleted.')
process.exit(0)
