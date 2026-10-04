// Founder records to the current shape (see functions/src/founders.ts):
// founderCohort is the city's display name ("Austin", "New York City"),
// founderCityId its id, founderCity the name, founderBadge "<City> Founder".
//
//   node scripts/migrate-founder-cohort.mjs --dry-run
//   node scripts/migrate-founder-cohort.mjs --apply
//
// Fixes cohorts saved as an id ("austin", "nyc") and fills in missing city
// fields from the cohort. Founders with no cohort (founder codes) are left
// alone. Reads the city list from functions/lib (npm --prefix functions run
// build first). Credentials as in init-cities.mjs.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { ZYLOVE_CITIES } = require('./lib/cities.js')

const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply')
  process.exit(1)
}
const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
initializeApp({ credential, projectId: 'zylove' })
const db = getFirestore()

// A cohort may be an id ("nyc") or a name ("Austin").
function cityFor(cohort) {
  if (typeof cohort !== 'string' || !cohort) return null
  return ZYLOVE_CITIES.find((c) => c.id === cohort || c.name.toLowerCase() === cohort.toLowerCase()) ?? null
}

const founders = await db.collection('users').where('isFounder', '==', true).get()
let changed = 0
for (const d of founders.docs) {
  const u = d.data()
  const city = cityFor(u.founderCohort)
  if (!city) {
    console.log(`skip ${d.id}: cohort ${JSON.stringify(u.founderCohort ?? null)} (no matching city)`)
    continue
  }
  const want = {
    founderCohort: city.name,
    founderCity: city.name,
    founderCityId: city.id,
    founderBadge: u.founderBadge || `${city.badgeName ?? city.name} Founder`,
  }
  const patch = Object.fromEntries(Object.entries(want).filter(([k, v]) => u[k] !== v))
  if (Object.keys(patch).length === 0) {
    console.log(`ok   ${d.id}: already current`)
    continue
  }
  changed++
  console.log(`${apply ? 'set ' : 'would set'} ${d.id}: ${JSON.stringify(patch)}`)
  if (apply) await d.ref.update(patch)
}
console.log(`\n${founders.size} founders · ${changed} ${apply ? 'updated' : 'to update'}`)
