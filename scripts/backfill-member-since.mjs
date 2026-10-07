// T&S Phase 1: account age from Firebase Auth for existing accounts —
// userInternal.accountCreatedAt (ms, server-only) and the public
// users.memberSince ("2026-10"). New and returning users get them from
// initUserDefaults on their next visit; this fills in everyone now.
//
//   node scripts/backfill-member-since.mjs --dry-run   counts only
//   node scripts/backfill-member-since.mjs --apply
//
// Prints counts only (no names, ids or dates). Idempotent: accounts that
// already have both are skipped. Credentials: Application Default
// Credentials; Auth via the Identity Toolkit REST API with the quota-project
// header (the admin Auth SDK fails under user ADC).

import { createRequire } from 'node:module'

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

// Same as memberSinceOf in functions/src/index.ts.
const memberSinceOf = (ms) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).format(new Date(ms)).slice(0, 7)

async function creationTimes(uids) {
  const out = new Map()
  for (let i = 0; i < uids.length; i += 100) {
    const r = await client.request({
      url: 'https://identitytoolkit.googleapis.com/v1/projects/zylove/accounts:lookup',
      method: 'POST',
      headers: { 'x-goog-user-project': 'zylove' },
      data: { localId: uids.slice(i, i + 100) },
    })
    for (const u of r.data.users ?? []) if (u.createdAt) out.set(u.localId, Number(u.createdAt))
  }
  return out
}

const users = (await db.collection('users').get()).docs.filter((d) => !/^(zbot|seed)-/.test(d.id) && d.data().isDeleted !== true)
const internals = new Map((await db.collection('userInternal').get()).docs.map((d) => [d.id, d.data()]))
const need = users.filter((u) => typeof internals.get(u.id)?.accountCreatedAt !== 'number' || typeof u.data().memberSince !== 'string')
const created = await creationTimes(need.map((u) => u.id))
let writes = 0
let noAuth = 0
for (const u of need) {
  const ms = created.get(u.id)
  if (!ms) {
    noAuth++
    continue
  }
  writes++
  if (!apply) continue
  if (typeof internals.get(u.id)?.accountCreatedAt !== 'number') await db.doc(`userInternal/${u.id}`).set({ accountCreatedAt: ms }, { merge: true })
  if (typeof u.data().memberSince !== 'string') await db.doc(`users/${u.id}`).set({ memberSince: memberSinceOf(ms) }, { merge: true })
}
console.log(`Accounts: ${users.length} live (bots and deleted skipped); already done: ${users.length - need.length}; to fill: ${writes}; no Auth record: ${noAuth}.`)
console.log(apply ? `Applied: ${writes} accounts.` : 'Dry run — nothing written.')
