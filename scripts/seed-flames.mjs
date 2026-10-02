// One-time dev seed: bot likes in the dev account's Flames (Play) queue.
//
//   node scripts/seed-flames.mjs                   write 5 entries
//   node scripts/seed-flames.mjs --dry-run         show what would be written
//   node scripts/seed-flames.mjs --range=1-20      pick from zbot-w-001…020 (the default)
//   node scripts/seed-flames.mjs --pick=zbot-w-003,zbot-w-018
//                                                  write exactly these bots (e.g. a dry run's picks)
//
// Same shape as seed-sparks.mjs, with mode 'play' and the bot's Play profile
// (users/{botUid}/playProfile/data) in likerProfile. A queue entry is keyed by
// the liker, so bots that already have one (a seeded Spark, say) are skipped
// rather than overwritten. Credentials: the service account below if present,
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
const [RANGE_FROM, RANGE_TO] = (arg('range') ?? '1-20').split('-').map(Number)
if (!(RANGE_FROM >= 1 && RANGE_TO >= RANGE_FROM)) throw new Error('--range must look like 1-20')
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

function strings(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []
}

const target = await db.doc(`users/${TARGET_UID}`).get()
if (!target.exists) throw new Error(`Target user ${TARGET_UID} not found`)

// Bots with a Play profile, not matched with the target, and not already in
// the target's queue (in either mode).
const candidates = []
for (const botUid of BOT_POOL) {
  const [botSnap, playSnap, matchSnap, queueSnap] = await Promise.all([
    db.doc(`users/${botUid}`).get(),
    db.doc(`users/${botUid}/playProfile/data`).get(),
    db.doc(`matches/${[TARGET_UID, botUid].sort().join('_')}`).get(),
    db.doc(`users/${TARGET_UID}/likeQueue/${botUid}`).get(),
  ])
  if (!botSnap.exists) console.log(`skip ${botUid}: no user doc`)
  else if (!playSnap.exists) console.log(`skip ${botUid}: no Play profile`)
  else if (matchSnap.exists) console.log(`skip ${botUid}: already matched with target`)
  else if (queueSnap.exists) console.log(`skip ${botUid}: already in the queue (${queueSnap.data().mode ?? 'spark'})`)
  else candidates.push({ botUid, bot: botSnap.data(), play: playSnap.data() })
}

const picked = PICKS ? candidates : shuffle(candidates).slice(0, COUNT)
if (picked.length < COUNT && !PICKS) console.log(`Only ${picked.length} eligible bots (wanted ${COUNT})`)

for (const { botUid, bot, play } of picked) {
  const playPhotos = strings(play.photoURLs)
  const photoURLs = playPhotos.length > 0 ? playPhotos : strings(bot.photoURLs)
  const score = Math.floor(Math.random() * 31) + 65 // 65–95
  const entry = {
    likerUid: botUid,
    likedAt: Date.now(),
    mode: 'play',
    dismissed: false,
    isExpired: false,
    compatibilityScore: score,
    likerProfile: {
      displayName: bot.displayName || 'Unknown',
      photoURLs,
      age: bot.age || 25,
      spiceLevel: play.spiceLevel ?? null,
      playBio: play.playBio ?? '',
      playInterestTags: strings(play.playInterestTags),
      // For the card: place and intent pill, as Spark entries carry.
      locationLabel: bot.locationLabel || 'Austin, TX',
      intent: bot.intent || 'open',
    },
  }
  if (!DRY_RUN) await db.doc(`users/${TARGET_UID}/likeQueue/${botUid}`).set(entry)
  const p = entry.likerProfile
  console.log(
    `${DRY_RUN ? 'would write' : 'wrote'} ${botUid}: ${p.displayName}, ${p.age} · ${score}% · ` +
      `${photoURLs.length} photo(s) · spice: ${p.spiceLevel ?? '—'} · ${p.playInterestTags.length} tags · "${p.playBio}"`,
  )
}
