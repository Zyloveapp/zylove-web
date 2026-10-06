// Stage 3 data migration (server-side Explore, matching preferences, account
// state). Used by scripts/migrate-stage3.mjs and the regression suite.
//
//   users/{uid} (bots included)
//     • matching preferences → private/matching (existing values win)
//     • suspension / bans / pending deletion / moderation timestamps →
//       userInternal; the moderation notice → private/account
//     • all of the above deleted from the public doc
//   sparkProfile/data, playProfile/data: their copies of the preferences
//     (attractedTo, age range, distance; bots' orientation) deleted — other
//     people can read those docs
//   exploreState/{uid}: people already acted on per mode (swipes, matches),
//     blocks (both directions, incl. the older blocks collection)
//   exploreIndex/{uid}: built for everyone discoverable (functions/lib/explore.js)

import { createRequire } from 'node:module'

const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const lib = (name) => require(new URL(`../../functions/lib/${name}.js`, import.meta.url).pathname)
const { MATCHING_FIELDS, INTERNAL_FIELDS } = lib('userData')

const STATE_FIELDS = [
  'isSuspended', 'suspendedAt', 'suspendedUntil', 'suspendedBy', 'suspendSource', 'suspendReason', 'suspendedPendingReview',
  'bannedAt', 'bannedBy', 'deletionRequestedAt', 'deletionScheduledFor', 'deletionReason', 'lastWarnedAt', 'lastThankedAt',
].filter((f) => INTERNAL_FIELDS.includes(f))
const SUBDOC_PREF_FIELDS = ['attractedTo', 'radiusMiles', 'ageMin', 'ageMax', 'orientation', 'matchableAs']
const MAX_ACTED = 5000
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : typeof v === 'string' ? [v] : [])
const ms = (v) => (typeof v === 'number' ? v : v && typeof v.toMillis === 'function' ? v.toMillis() : 0)

export async function planStage3(db) {
  const plan = { users: [], subdocs: [], states: [], counts: {} }
  const count = (k, n = 1) => (plan.counts[k] = (plan.counts[k] ?? 0) + n)
  const users = (await db.collection('users').get()).docs

  for (const u of users) {
    const uid = u.id
    const root = u.data()
    const [matchingSnap, internalSnap, accountSnap] = await db.getAll(
      db.doc(`users/${uid}/private/matching`),
      db.doc(`userInternal/${uid}`),
      db.doc(`users/${uid}/private/account`),
    )
    const m = matchingSnap.data() ?? {}
    const internal = internalSnap.data() ?? {}
    const toMatching = {}
    for (const f of MATCHING_FIELDS) if (root[f] !== undefined && m[f] === undefined) toMatching[f] = root[f]
    const toInternal = {}
    for (const f of STATE_FIELDS) {
      // A suspension always carries over (userInternal may hold the default false).
      if (f === 'isSuspended') {
        if (root[f] === true && internal[f] !== true) toInternal[f] = true
        continue
      }
      if (root[f] === undefined || internal[f] !== undefined) continue
      toInternal[f] = root[f]
    }
    const toAccount = root.adminNotice !== undefined && accountSnap.data()?.adminNotice === undefined ? { adminNotice: root.adminNotice } : null
    const scrub = [...MATCHING_FIELDS, ...STATE_FIELDS, 'adminNotice'].filter((f) => root[f] !== undefined)
    if (scrub.length || Object.keys(toMatching).length || Object.keys(toInternal).length || toAccount) {
      plan.users.push({ uid, toMatching, toInternal, toAccount, scrub })
      count(uid.startsWith('zbot-') ? 'bot public docs scrubbed' : 'public docs scrubbed')
      if (Object.keys(toMatching).length) count('private/matching written')
      if (toInternal.isSuspended === true) count('suspensions moved to userInternal')
      if (toAccount) count('moderation notices moved to private/account')
    }
  }

  for (const group of ['sparkProfile', 'playProfile']) {
    for (const d of (await db.collectionGroup(group).get()).docs) {
      const fields = SUBDOC_PREF_FIELDS.filter((f) => d.get(f) !== undefined)
      if (!fields.length) continue
      plan.subdocs.push({ path: d.ref.path, fields })
      count(`${group} preference copies removed`)
    }
  }

  // Already acted on (per mode) and blocks.
  const acted = new Map() // uid → { spark: Map(target → time), play: … }
  const add = (uid, mode, target, at) => {
    if (!uid || !target || uid === target) return
    const s = acted.get(uid) ?? { spark: new Map(), play: new Map() }
    acted.set(uid, s)
    for (const md of mode ? [mode] : ['spark', 'play']) s[md].set(target, Math.max(s[md].get(target) ?? 0, at))
  }
  for (const d of (await db.collection('swipes').get()).docs) {
    const s = d.data()
    add(s.swiperId, s.mode === 'play' ? 'play' : s.mode === 'spark' ? 'spark' : null, s.swipedId, ms(s.timestamp))
  }
  for (const d of (await db.collection('matches').get()).docs) {
    const mt = d.data()
    const users = strings(mt.users ?? mt.participants)
    const mode = mt.mode === 'play' ? 'play' : 'spark'
    for (const a of users) for (const b of users) add(a, mode, b, ms(mt.matchedAt) || ms(mt.createdAt))
  }
  const blocked = new Map()
  const block = (a, b) => {
    if (!a || !b || a === b) return
    blocked.set(a, (blocked.get(a) ?? new Set()).add(b))
    blocked.set(b, (blocked.get(b) ?? new Set()).add(a))
  }
  for (const d of (await db.collectionGroup('blockedUsers').get()).docs) block(d.ref.parent.parent.id, d.id)
  for (const d of (await db.collection('blocks').get().catch(() => ({ docs: [] }))).docs) block(d.get('blockerUid'), d.get('blockedUid'))
  const uids = new Set([...acted.keys(), ...blocked.keys()])
  for (const uid of uids) {
    const s = acted.get(uid)
    const order = (mp) => [...(mp ?? new Map()).entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t).slice(-MAX_ACTED)
    plan.states.push({ uid, spark: order(s?.spark), play: order(s?.play), blocked: [...(blocked.get(uid) ?? [])] })
  }
  count('exploreState docs', plan.states.length)
  count('already-acted entries', plan.states.reduce((n, s) => n + s.spark.length + s.play.length, 0))
  count('block pairs (both directions)', plan.states.reduce((n, s) => n + s.blocked.length, 0))
  plan.indexUids = users.map((u) => u.id)
  return plan
}

// Phase 1 (before the new app goes live): only the Explore index and
// already-seen state — nothing moves, so today's app keeps working.
export async function applyStage3IndexOnly({ db }, plan, buildEntry) {
  return applyStage3({ db, FieldValue: null }, { ...plan, users: [], subdocs: [] }, buildEntry)
}

// One user's moves (seeding test users).
export async function migrateUserStage3({ db, FieldValue }, uid) {
  const plan = await planStage3(db)
  const user = plan.users.find((u) => u.uid === uid)
  const subdocs = plan.subdocs.filter((s) => s.path.startsWith(`users/${uid}/`))
  return applyStage3({ db, FieldValue }, { users: user ? [user] : [], subdocs, states: [], indexUids: [] }, async () => null)
}

export async function applyStage3({ db, FieldValue }, plan, buildEntry) {
  const writes = []
  for (const u of plan.users) {
    if (Object.keys(u.toMatching).length) writes.push((b) => b.set(db.doc(`users/${u.uid}/private/matching`), u.toMatching, { merge: true }))
    if (Object.keys(u.toInternal).length) writes.push((b) => b.set(db.doc(`userInternal/${u.uid}`), u.toInternal, { merge: true }))
    if (u.toAccount) writes.push((b) => b.set(db.doc(`users/${u.uid}/private/account`), u.toAccount, { merge: true }))
    if (u.scrub.length) writes.push((b) => b.update(db.doc(`users/${u.uid}`), Object.fromEntries(u.scrub.map((f) => [f, FieldValue.delete()]))))
  }
  for (const s of plan.subdocs) writes.push((b) => b.update(db.doc(s.path), Object.fromEntries(s.fields.map((f) => [f, FieldValue.delete()]))))
  for (const s of plan.states) {
    writes.push((b) => b.set(db.doc(`exploreState/${s.uid}`), { spark: { acted: s.spark, deck: [] }, play: { acted: s.play, deck: [] }, blocked: s.blocked }, { merge: true }))
  }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch()
    for (const w of writes.slice(i, i + 400)) w(batch)
    await batch.commit()
  }
  // The index, from the migrated data.
  let indexed = 0
  for (const uid of plan.indexUids) {
    const entry = await buildEntry(uid)
    if (entry) {
      await db.doc(`exploreIndex/${uid}`).set(entry)
      indexed++
    } else await db.doc(`exploreIndex/${uid}`).delete()
  }
  return { writes: writes.length, indexed }
}
