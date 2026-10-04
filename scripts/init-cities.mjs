// One-time setup for city founding circles (see functions/src/founders.ts).
//
//   node scripts/init-cities.mjs --dry-run  show what would be written
//   node scripts/init-cities.mjs --apply    create config/city_{id} + publicStats/city_{id}
//
// Reads the city list from the compiled functions (functions/lib/cities.js),
// so run `npm --prefix functions run build` first.
//
// Create-only: a city doc that already exists is left alone (its counters
// are live data), so re-running is safe. Austin starts from config/launch's
// existing Austin counts, so founders from before city circles still count.
// Credentials: the service account below if present, otherwise Application
// Default Credentials (gcloud auth application-default login).

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

// firebase-admin is already a dependency of the web functions codebase.
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { ZYLOVE_CITIES } = require('./lib/cities.js')

const PROJECT_ID = 'zylove'
const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const FOUNDER_TARGET = 50 // per half: 50 women + 50 men
const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply')
  process.exit(1)
}

const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
initializeApp({ credential, projectId: PROJECT_ID })
const db = getFirestore()

const num = (v) => (typeof v === 'number' ? v : 0)
const launch = (await db.doc('config/launch').get()).data() ?? {}

let created = 0
let skipped = 0
for (const city of ZYLOVE_CITIES) {
  const configRef = db.doc(`config/city_${city.id}`)
  const statsRef = db.doc(`publicStats/city_${city.id}`)
  const [configSnap, statsSnap] = await Promise.all([configRef.get(), statsRef.get()])

  // austinWomenCount/austinMenCount are the Austin-area auto-assigned founders.
  const womenCount = city.id === 'austin' ? num(launch.austinWomenCount) : 0
  const menCount = city.id === 'austin' ? num(launch.austinMenCount) : 0
  const config = {
    id: city.id,
    name: city.name,
    state: city.state,
    lat: city.lat,
    lng: city.lng,
    radiusMiles: city.radiusMiles,
    womenCount,
    menCount,
    founderTarget: FOUNDER_TARGET,
    botsActive: true,
  }
  const stats = { members: womenCount + menCount, capacity: FOUNDER_TARGET * 2, cityName: city.name, state: city.state }

  for (const [ref, snap, data] of [
    [configRef, configSnap, config],
    [statsRef, statsSnap, stats],
  ]) {
    if (snap.exists) {
      skipped++
      console.log(`exists, left unchanged: ${ref.path}`)
      continue
    }
    created++
    console.log(`${apply ? 'create' : 'would create'}: ${ref.path} ${JSON.stringify(data)}`)
    if (apply) await ref.create({ ...data, createdAt: FieldValue.serverTimestamp() })
  }
}

console.log(`\n${ZYLOVE_CITIES.length} cities · ${apply ? 'created' : 'to create'} ${created} docs · ${skipped} already existed`)
if (!apply) console.log('Dry run — re-run with --apply to write.')
