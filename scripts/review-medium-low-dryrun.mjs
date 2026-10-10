// Fresh-eyes review, Medium/Low fixes: what the existing data needs. Read-only;
// prints counts only (no ids, names or text). Production data never lands in
// the repo.
//
//   (cd functions && npm run build)
//   node scripts/review-medium-low-dryrun.mjs
//
// Credentials: Application Default Credentials.
//
//   F-112  profiles whose public text a write would now mask (bio, prompts,
//          Play bio / prompts) — masked on their next save, or by a backfill;
//          and root city labels that differ from the server's own label
//   F-116  founder records with no phone hash (claimed before), revoked ones
//          (the history they'd need)
//   F-119  Spark pairs where someone's dealbreaker fired — their per-viewer
//          scores differ from the shared one (scripts/rescore-pairs.mjs fills
//          sparkScoreFor on its next run)
//   Low    subscriptions now past due (the 14-day grace counts from their last
//          update until a new failure records pastDueSince)

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
initializeApp({ credential: applicationDefault(), projectId: 'zylove' })
const db = getFirestore()
const { needsMask } = require('./lib/profileText.js')

const answers = (v) => (Array.isArray(v) ? v.map((p) => p?.answer).filter((a) => typeof a === 'string') : [])
const mapAnswers = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v).filter((a) => typeof a === 'string') : [])

const users = (await db.collection('users').get()).docs
let sparkText = 0
let labelDiffers = 0
for (const u of users) {
  const d = u.data()
  if (/^(zbot|seed)-/.test(u.id)) continue
  if ([d.bio, d.dynamicPrompt, ...answers(d.promptAnswers)].some(needsMask)) sparkText++
  if (typeof d.locationLabel === 'string' && d.locationLabel) {
    const own = (await db.doc(`users/${u.id}/private/account`).get()).data()?.location?.label
    if (own !== d.locationLabel) labelDiffers++
  }
}
let playText = 0
for (const p of (await db.collectionGroup('playProfile').get()).docs) {
  if (p.id !== 'data' || /^(zbot|seed)-/.test(p.ref.parent.parent?.id ?? '')) continue
  const d = p.data()
  if ([d.playBio, d.bio, d.dynamicPrompt, ...answers(d.promptAnswers), ...mapAnswers(d.playPromptAnswers)].some(needsMask)) playText++
}

const founders = (await db.collection('founderRecords').get()).docs.map((d) => d.data())
const noHash = founders.filter((f) => typeof f.phoneHash !== 'string').length
const revoked = founders.filter((f) => f.status === 'revoked').length

let pairs = 0
let dealbreakerPairs = 0
let withViews = 0
for (const p of (await db.collection('pairs').get()).docs) {
  pairs++
  if (p.data().sparkScoreFor) withViews++
  const details = (await db.doc(`pairs/${p.id}/modes/spark`).get()).data()
  const fired = details?.triggeredDealbreakers ?? p.data().triggeredDealbreakers ?? []
  if (Array.isArray(fired) && fired.length > 0) dealbreakerPairs++
}

const pastDue = (await db.collection('userInternal').where('subscriptionStatus', '==', 'past_due').get()).size

console.log({
  users: users.length,
  'F-112 Spark profiles with contact details in public text': sparkText,
  'F-112 Play profiles with contact details in public text': playText,
  'F-112 root city labels not the server\'s': labelDiffers,
  'F-116 founder records': founders.length,
  'F-116 founder records without a phone hash': noHash,
  'F-116 revoked founder records': revoked,
  'F-119 Spark pairs': pairs,
  'F-119 pairs with a fired dealbreaker (per-viewer score differs)': dealbreakerPairs,
  'F-119 pairs already scored per viewer': withViews,
  'Low past-due subscriptions': pastDue,
})
