// Stage C: plans enforced server-side. See scripts/lib/stageC.mjs.
//
//   (cd functions && npm run build)
//   node scripts/migrate-stageC.mjs --dry-run   counts, and the entitlement each user would get
//   node scripts/migrate-stageC.mjs --apply
//
// After the Stage C functions are live, before the Stage C rules (the rules
// read the entitlement this writes). Idempotent. Back up first.
// Credentials: Application Default Credentials. Phone numbers (for the
// trial history) come from the Identity Toolkit REST API with the
// x-goog-user-project header — the admin Auth SDK fails under user ADC.

import { createRequire } from 'node:module'
import { planStageC, applyStageC, previewEntitlements } from './lib/stageC.mjs'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')
const { GoogleAuth } = require('google-auth-library')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()
const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient()
async function phoneOf(uid) {
  const r = await client.request({
    url: 'https://identitytoolkit.googleapis.com/v1/projects/zylove/accounts:lookup',
    method: 'POST',
    headers: { 'x-goog-user-project': 'zylove' },
    data: { localId: [uid] },
  })
  return r.data.users?.[0]?.phoneNumber ?? null
}

const plan = await planStageC(db, { phoneOf })
for (const [k, n] of Object.entries(plan.counts)) console.log(`  ${k.padEnd(56)} ${n}`)
if (!apply) {
  console.log('\nEntitlements after the migration (tier (source)):')
  for (const [k, n] of Object.entries(await previewEntitlements(db, plan)).sort()) console.log(`  ${k.padEnd(30)} ${n}`)
  console.log('\nDry run — nothing written.')
  process.exit(0)
}
const r = await applyStageC({ db, FieldValue }, plan)
console.log(`\nApplied: ${r.writes} writes. Entitlements:`)
for (const [k, n] of Object.entries(r.tiers).sort()) console.log(`  ${k.padEnd(30)} ${n}`)
