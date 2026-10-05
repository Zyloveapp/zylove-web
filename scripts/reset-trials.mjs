// One-time: stop every running trial clock. Trials now start when discovery
// opens in the user's market (functions/src/trial.ts), so nobody signed up
// before that change should have one. Removes trialStartedAt, trialEndsAt
// and trialExpired, and turns a leftover subscriptionTier 'trial' (revoked
// founders) into 'free'. Paying subscribers and bots are left alone. If a
// user's market is already open, initUserDefaults starts a fresh trial on
// their next visit.
//
//   node scripts/reset-trials.mjs --dry-run   list who would change
//   node scripts/reset-trials.mjs --apply     change them
//
// Credentials: Application Default Credentials (gcloud auth
// application-default login).

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore')
// The functions build (npm --prefix functions run build) has the shared rules.
const { cityOpen, marketFor } = require('../functions/lib/trial.js')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()

const isBot = (uid) => uid.startsWith('zbot-') || uid.startsWith('seed-')
const paying = (u) => u.subscriptionStatus === 'active' || u.subscriptionStatus === 'past_due'
const hasTrialFields = (u) =>
  u.trialStartedAt !== undefined || u.trialEndsAt !== undefined || u.trialExpired !== undefined || u.subscriptionTier === 'trial'
const when = (v) => (v instanceof Timestamp ? v.toDate().toISOString().slice(0, 10) : v === undefined ? '—' : String(v))

const openCities = new Set(
  (await db.collection('config').get()).docs.filter((d) => d.id.startsWith('city_') && cityOpen(d.data())).map((d) => d.id.slice(5)),
)
const users = await db.collection('users').get()
const affected = users.docs.filter((d) => !isBot(d.id) && !paying(d.data()) && hasTrialFields(d.data()))

console.log(`${users.size} users; ${affected.length} with trial fields to clear. Open markets: ${[...openCities].join(', ') || 'none'}\n`)
for (const d of affected) {
  const u = d.data()
  const g = Array.isArray(u.genderIdentity) ? u.genderIdentity[0] : u.genderIdentity
  const market = marketFor(u)
  console.log(
    [
      `${d.id.slice(0, 6)}…`,
      String(u.displayName ?? '?').padEnd(14),
      String(g ?? '?').padEnd(10),
      u.isFounder === true ? 'founder' : '       ',
      `tier=${u.subscriptionTier ?? '—'}`,
      `started=${when(u.trialStartedAt)}`,
      `ends=${when(u.trialEndsAt)}`,
      `expired=${u.trialExpired ?? '—'}`,
      `market=${market ? `${market.name}${openCities.has(market.id) ? ' (open)' : ''}` : 'none'}`,
    ].join('  '),
  )
}

if (!apply) {
  console.log('\nDry run — nothing written. Re-run with --apply to clear these.')
  process.exit(0)
}

for (let i = 0; i < affected.length; i += 450) {
  const batch = db.batch()
  for (const d of affected.slice(i, i + 450)) {
    batch.update(d.ref, {
      trialStartedAt: FieldValue.delete(),
      trialEndsAt: FieldValue.delete(),
      trialExpired: FieldValue.delete(),
      ...(d.data().subscriptionTier === 'trial' && { subscriptionTier: 'free' }),
    })
  }
  await batch.commit()
}
console.log(`\nCleared trial fields on ${affected.length} users.`)
