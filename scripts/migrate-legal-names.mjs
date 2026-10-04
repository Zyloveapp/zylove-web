// One-time: move legalName off users/{uid} (readable by any signed-in user)
// into the owner-only users/{uid}/private/identity doc, where onboarding now
// writes it. Accounts that onboarded on web before that change still have
// the root field, and the rules stop clients removing it themselves.
//
//   node scripts/migrate-legal-names.mjs --dry-run  count what would move
//   node scripts/migrate-legal-names.mjs --apply    move it
//
// An existing private/identity doc is never overwritten (it's the newer
// value); the root field is removed either way. Names are never printed.
// Credentials: the service account below if present, otherwise Application
// Default Credentials (gcloud auth application-default login).

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')

const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const apply = process.argv.includes('--apply')
const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
initializeApp({ credential, projectId: 'zylove' })
const db = getFirestore()

const users = await db.collection('users').where('legalName', '!=', null).select('legalName').get()
const plans = await Promise.all(
  users.docs.map(async (d) => {
    const legalName = d.data().legalName
    const identityRef = d.ref.collection('private').doc('identity')
    const hasPrivate = (await identityRef.get()).exists
    const valid = typeof legalName === 'string' && legalName.trim() !== ''
    return { ref: d.ref, identityRef, legalName: valid ? legalName.trim() : null, hasPrivate }
  }),
)
const toCopy = plans.filter((p) => p.legalName && !p.hasPrivate)
console.log(`${plans.length} users with legalName on the main doc`)
console.log(`  ${toCopy.length} to copy into private/identity`)
console.log(`  ${plans.length - toCopy.length} already have private/identity (or an empty value) — root field just removed`)

if (!apply) {
  console.log('Dry run — re-run with --apply to migrate.')
  process.exit(0)
}

let migrated = 0
for (let i = 0; i < plans.length; i += 200) {
  const batch = db.batch()
  for (const p of plans.slice(i, i + 200)) {
    if (p.legalName && !p.hasPrivate) {
      batch.create(p.identityRef, { legalName: p.legalName, legalNameSetAt: FieldValue.serverTimestamp() })
    }
    batch.update(p.ref, { legalName: FieldValue.delete() })
  }
  await batch.commit()
  migrated += Math.min(200, plans.length - i)
}
const left = await db.collection('users').where('legalName', '!=', null).count().get()
console.log(`Migrated ${migrated} (${toCopy.length} copied). ${left.data().count} still have legalName on the main doc.`)
