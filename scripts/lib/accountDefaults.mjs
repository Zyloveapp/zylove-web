// H1 (fresh-eyes review): existing accounts brought in line with the
// server-side defaults (functions/src/accountDefaults.ts). Used by
// scripts/backfill-account-defaults.mjs and the regression suite
// (e2e/tests/42-review-accounts.spec.mjs).
//
// Accounts that never called initUserDefaults can have:
//   • no accountCreatedAt (probation, trust and the scam-report bar read it)
//     or memberSince
//   • no trial in a city that's open — and a stored entitlement of Elite
//     "pre-launch" with no end, which nothing recomputes until one of their
//     docs changes
// For each live account (curated and deleted ones skipped): the account age
// from Firebase Auth, the trial as initUserDefaults decides it (the phone's
// trialHistory first: a past trial comes back, a past paid plan means Free;
// a new one only in an open launch city), then the entitlement recomputed.
//
// The plan uses the functions' own code (functions/lib: decideTrial,
// computeEntitlement), so the dry run shows what --apply will do.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const lib = (name) => require(new URL(`../../functions/lib/${name}.js`, import.meta.url).pathname)
const isBot = (uid) => /^(zbot|seed)-/.test(uid)

// authOf(uids) → Map uid → { phone, createdAt } (from the Auth record).
export async function planAccountDefaults(db, { authOf, onlyUids = null } = {}) {
  const { decideTrial } = lib('accountDefaults')
  const { computeEntitlement, cityIsOpen, launchCityOf } = lib('entitlements')
  const { newTrial, priorTrial } = lib('trial')
  const plan = { uids: [], refresh: [], known: {}, counts: {}, before: {}, after: {} }
  const count = (k, n = 1) => (plan.counts[k] = (plan.counts[k] ?? 0) + n)
  for (const k of [
    'live accounts',
    'missing accountCreatedAt',
    'missing memberSince',
    'no Auth record (account age left missing)',
    'stored Elite pre-launch while their city is open (the H1 hole)',
    'trial: new (open city, phone never had one)',
    'trial: the one the phone had before, restored',
    'trial: none — phone paid before (Free)',
    'no trial yet, nothing to start (city not open, exempt or suspended)',
    'entitlements to recompute',
  ])
    plan.counts[k] = 0
  const cities = new Map()
  const cityOpen = async (id) => {
    if (!cities.has(id)) cities.set(id, cityIsOpen((await db.doc(`config/city_${id}`).get()).data()))
    return cities.get(id)
  }

  const users = onlyUids
    ? (await Promise.all(onlyUids.map((u) => db.doc(`users/${u}`).get()))).filter((s) => s.exists)
    : (await db.collection('users').get()).docs
  const live = users.filter((u) => !isBot(u.id) && u.data().isDeleted !== true)
  count('live accounts', live.length)
  const auth = await authOf(live.map((u) => u.id))
  for (const u of live) {
    const uid = u.id
    const root = u.data()
    const [internalSnap, locSnap, matchingSnap] = await Promise.all([
      db.doc(`userInternal/${uid}`).get(),
      db.doc(`userLocations/${uid}`).get(),
      db.doc(`users/${uid}/private/matching`).get(),
    ])
    const internal = internalSnap.data() ?? {}
    const loc = locSnap.data()
    const m = matchingSnap.data() ?? {}
    const matching = { genderIdentity: m.genderIdentity ?? root.genderIdentity, matchableAs: m.matchableAs ?? root.matchableAs }
    const city = launchCityOf(loc)
    const open = city ? await cityOpen(city) : false
    const stored = internal.entitlement
    const tally = (side, e) => {
      const k = `${e?.tier ?? 'none'} (${e?.source ?? '-'})`
      plan[side][k] = (plan[side][k] ?? 0) + 1
    }
    tally('before', stored)
    if (stored?.source === 'prelaunch' && open && internal.trialStartedAt === undefined) count('stored Elite pre-launch while their city is open (the H1 hole)')

    const a = auth.get(uid) ?? { phone: null, createdAt: null }
    plan.known[uid] = a
    if (typeof internal.accountCreatedAt !== 'number') count('missing accountCreatedAt')
    if (typeof root.memberSince !== 'string') count('missing memberSince')
    if ((typeof internal.accountCreatedAt !== 'number' || typeof root.memberSince !== 'string') && !a.createdAt) count('no Auth record (account age left missing)')

    let after = internal
    let todo = typeof internal.accountCreatedAt !== 'number' || typeof root.memberSince !== 'string'
    if (internal.trialStartedAt === undefined && internal.hadPaidPlan !== true) {
      const d = decideTrial({ root, internal, matching, cityOpen: open, prior: await priorTrial(a.phone) })
      if (d.kind === 'new') count('trial: new (open city, phone never had one)')
      else if (d.kind === 'prior') count('trial: the one the phone had before, restored')
      else if (d.kind === 'paid') count('trial: none — phone paid before (Free)')
      else count('no trial yet, nothing to start (city not open, exempt or suspended)')
      if (d.kind === 'new') after = { ...internal, ...newTrial() }
      if (d.kind === 'prior') after = { ...internal, trialStartedAt: d.trialStartedAt, trialEndsAt: d.trialEndsAt, trialExpired: d.trialEndsAt.toMillis() <= Date.now() }
      if (d.kind === 'paid') after = { ...internal, hadPaidPlan: true }
      if (d.kind !== 'none') todo = true
    }
    const e = computeEntitlement({
      root,
      plan: after,
      matching: { matchableAs: root.matchableAs, genderIdentity: root.genderIdentity, ...m },
      loc,
      marketOpen: open,
      linkedCityOpen: open,
    })
    tally('after', e)
    if (todo) plan.uids.push(uid)
    if (stored?.tier !== e.tier || stored?.source !== e.source) {
      plan.refresh.push(uid)
      count('entitlements to recompute')
    }
  }
  return plan
}

export async function applyAccountDefaults(plan) {
  const { ensureAccountDefaults } = lib('accountDefaults')
  const { refreshPlayAccess } = lib('playAccess')
  let filled = 0
  // With the Auth values in hand (the admin Auth SDK isn't usable under user
  // credentials), so the trial history is read by the right phone.
  for (const uid of plan.uids) {
    const r = await ensureAccountDefaults(uid, plan.known[uid] ?? { phone: null, createdAt: null })
    if (r.filled.length) filled++
  }
  const db = require('firebase-admin/firestore').getFirestore()
  const tiers = {}
  for (const uid of new Set([...plan.uids, ...plan.refresh])) {
    await refreshPlayAccess(uid)
    const t = (await db.doc(`userInternal/${uid}`).get()).get('entitlement')
    const k = `${t?.tier ?? 'none'} (${t?.source ?? '-'})`
    tiers[k] = (tiers[k] ?? 0) + 1
  }
  return { filled, tiers }
}
