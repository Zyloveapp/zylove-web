// One-time dev seed: bot likes in the dev account's Sparks queue.
//
//   node scripts/seed-sparks.mjs                   write 5 entries
//   node scripts/seed-sparks.mjs --dry-run         show what would be written
//   node scripts/seed-sparks.mjs --range=11-20     pick from zbot-w-011…020 (default 1-10)
//   node scripts/seed-sparks.mjs --pick=zbot-w-012,zbot-w-017
//                                                  write exactly these bots (e.g. a dry run's picks)
//
// Writes users/{TARGET_UID}/likeQueue/{botUid} in the same shape botEngine's
// botLikeOnly uses. Credentials: the service account below if present,
// otherwise Application Default Credentials (gcloud auth application-default login).

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

// firebase-admin is already a dependency of the web functions codebase.
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

const PROJECT_ID = 'zylove'
const TARGET_UID = 'ipKWm5GSY6VrGLIErDBA6Zj61W62'
function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const [RANGE_FROM, RANGE_TO] = (arg('range') ?? '1-10').split('-').map(Number)
if (!(RANGE_FROM >= 1 && RANGE_TO >= RANGE_FROM)) throw new Error('--range must look like 11-20')
const PICKS = arg('pick')?.split(',').filter(Boolean) ?? null
const BOT_POOL =
  PICKS ??
  Array.from({ length: RANGE_TO - RANGE_FROM + 1 }, (_, i) => `zbot-w-${String(RANGE_FROM + i).padStart(3, '0')}`)
const COUNT = 5
const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const DRY_RUN = process.argv.includes('--dry-run')

const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
console.log(`Credentials: ${existsSync(SERVICE_ACCOUNT) ? 'service account' : 'application default'}`)

initializeApp({ credential, projectId: PROJECT_ID })
const db = getFirestore()

function shuffle(items) {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const target = await db.doc(`users/${TARGET_UID}`).get()
if (!target.exists) throw new Error(`Target user ${TARGET_UID} not found`)

// Bots that exist and aren't already matched with the target.
const candidates = []
for (const botUid of BOT_POOL) {
  const [botSnap, matchSnap] = await Promise.all([
    db.doc(`users/${botUid}`).get(),
    db.doc(`matches/${[TARGET_UID, botUid].sort().join('_')}`).get(),
  ])
  if (!botSnap.exists) console.log(`skip ${botUid}: no user doc`)
  else if (matchSnap.exists) console.log(`skip ${botUid}: already matched with target`)
  else candidates.push({ botUid, bot: botSnap.data() })
}

const picked = PICKS ? candidates : shuffle(candidates).slice(0, COUNT)
if (picked.length < COUNT) console.log(`Only ${picked.length} eligible bots (wanted ${COUNT})`)

for (const { botUid, bot } of picked) {
  const photoURLs = Array.isArray(bot.photoURLs) ? bot.photoURLs : []
  const traits = Array.isArray(bot.personalityTraits) ? bot.personalityTraits : []
  const values = Array.isArray(bot.relationshipValues) ? bot.relationshipValues : []
  const score = Math.floor(Math.random() * 31) + 65 // 65–95
  const entry = {
    likerUid: botUid,
    likedAt: Date.now(),
    compatibilityScore: score,
    dealbreakersTriggered: [],
    istopPicks: score >= 80,
    breakdown: {},
    dismissed: false,
    isExpired: false,
    action: 'like',
    mode: 'spark',
    likerProfile: {
      displayName: bot.displayName || 'Unknown',
      age: bot.age || 25,
      photoURL: photoURLs[0] || bot.photoURL || null,
      photoURLs,
      locationLabel: bot.locationLabel || 'Austin, TX',
      intent: bot.intent || 'spark',
      verificationStatus: 'unverified',
      bio: bot.bio || '',
      personalityTraits: traits,
      personalityTags: traits,
      topValues: values,
      relationshipValues: values,
      lifestyleTags: bot.lifestyleTags || [],
      weekendVibes: bot.weekendVibes || [],
      loveLangGive: bot.loveLangGive || [],
      loveLangReceive: bot.loveLangReceive || [],
      promptAnswers: bot.promptAnswers || [],
    },
  }
  if (!DRY_RUN) await db.doc(`users/${TARGET_UID}/likeQueue/${botUid}`).set(entry)
  const p = entry.likerProfile
  console.log(
    `${DRY_RUN ? 'would write' : 'wrote'} ${botUid}: ${p.displayName}, ${p.age} · ${score}% · ` +
      `${photoURLs.length} photo(s) · traits: ${traits.join(', ') || '—'}`,
  )
}
