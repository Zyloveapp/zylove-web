// One-time setup for the Austin Founding Circle (see functions/src/founders.ts).
//
//   node scripts/init-launch-config.mjs            create config/launch + publicStats/founding
//   node scripts/init-launch-config.mjs --dry-run  show what would be written
//
// Create-only: if config/launch already exists it's left alone (the counters
// are live data), so re-running is safe. Credentials: the service account
// below if present, otherwise Application Default Credentials
// (gcloud auth application-default login).

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

// firebase-admin is already a dependency of the web functions codebase.
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')

const PROJECT_ID = 'zylove'
const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const dryRun = process.argv.includes('--dry-run')

const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
initializeApp({ credential, projectId: PROJECT_ID })
const db = getFirestore()

const launch = {
  austinWomenCount: 0,
  austinMenCount: 0,
  launchThreshold: 50,
  botsActive: true,
  totalActiveUsers: 0,
}
const publicFounding = { members: 0, capacity: launch.launchThreshold * 2 }

const launchRef = db.doc('config/launch')
const publicRef = db.doc('publicStats/founding')

const existing = await launchRef.get()
if (existing.exists) {
  console.log('config/launch already exists — left unchanged:', JSON.stringify(existing.data()))
  process.exit(0)
}

if (dryRun) {
  console.log('[dry run] would create config/launch:', JSON.stringify(launch))
  console.log('[dry run] would set publicStats/founding:', JSON.stringify(publicFounding))
  process.exit(0)
}

await db.runTransaction(async (tx) => {
  const again = await tx.get(launchRef)
  if (again.exists) throw new Error('config/launch was created concurrently')
  tx.create(launchRef, { ...launch, createdAt: FieldValue.serverTimestamp() })
  tx.set(publicRef, { ...publicFounding, updatedAt: FieldValue.serverTimestamp() })
})
const written = (await launchRef.get()).data()
console.log('Created config/launch:', JSON.stringify({ ...written, createdAt: written.createdAt?.toDate?.().toISOString() }))
console.log('Set publicStats/founding:', JSON.stringify(publicFounding))
