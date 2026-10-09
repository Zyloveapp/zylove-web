// H1 (fresh-eyes review): existing accounts brought in line with the
// server-side defaults — account age, the trial (once per phone) and the
// entitlement, for accounts whose app never called initUserDefaults. See
// scripts/lib/accountDefaults.mjs.
//
//   (cd functions && npm run build)
//   node scripts/backfill-account-defaults.mjs --dry-run
//       counts only (no names, ids, numbers or dates): live accounts; missing
//       accountCreatedAt / memberSince; accounts with no Auth record; stored
//       Elite pre-launch while their city is open (the H1 hole); trials that
//       would start new, come back from the phone's history, or not start
//       because the phone paid before; entitlements before and after
//       (tier (source))
//   node scripts/backfill-account-defaults.mjs --apply
//       fills them in (each account in a transaction, only what's still
//       missing) and recomputes the entitlements, then prints them
//
// Run --apply after the H1 functions are live (until then initUserDefaults
// and the old computeEntitlement would disagree with it). Idempotent.
// Credentials: Application Default Credentials. Phone numbers and creation
// times come from the Identity Toolkit REST API with the
// x-goog-user-project header — the admin Auth SDK fails under user ADC.

import { createRequire } from 'node:module'
import { applyAccountDefaults, planAccountDefaults } from './lib/accountDefaults.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { GoogleAuth } = require('google-auth-library')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()
const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient()
async function authOf(uids) {
  const out = new Map()
  for (let i = 0; i < uids.length; i += 100) {
    const r = await client.request({
      url: 'https://identitytoolkit.googleapis.com/v1/projects/zylove/accounts:lookup',
      method: 'POST',
      headers: { 'x-goog-user-project': 'zylove' },
      data: { localId: uids.slice(i, i + 100) },
    })
    for (const u of r.data.users ?? []) out.set(u.localId, { phone: u.phoneNumber ?? null, createdAt: u.createdAt ? Number(u.createdAt) : null })
  }
  return out
}

const plan = await planAccountDefaults(db, { authOf })
for (const [k, n] of Object.entries(plan.counts)) console.log(`  ${k.padEnd(72)} ${n}`)
const show = (title, m) => {
  console.log(`\n${title}`)
  for (const [k, n] of Object.entries(m).sort()) console.log(`  ${k.padEnd(30)} ${n}`)
}
show('Entitlements stored now (tier (source)):', plan.before)
show('Entitlements after (tier (source)):', plan.after)
if (!apply) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
const r = await applyAccountDefaults(plan)
console.log(`\nApplied: ${r.filled} accounts filled in.`)
show('Entitlements recomputed (tier (source)):', r.tiers)
process.exit(0)
