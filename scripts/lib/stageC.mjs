// Stage C data migration (plans enforced server-side). Used by
// scripts/migrate-stageC.mjs and the regression suite.
//
//   pairs/{id}: sparkBreakdown + triggeredDealbreakers → modes/spark (Spark+),
//     tier1Spark → modes/deep (Elite); removed from the pair doc
//   users/{uid}/private/matching: radiusMiles "no limit" (null) or over 100 → 100
//   userLocations/{uid}: no launch city → linkedCityId (nearest launch or
//     major city), so their Free period waits for that city
//   userInternal/{uid}:
//     • hadPaidPlan for subscriptions that ended (canceled / unpaid)
//     • subscriptionTier 'elite' stamped for an identity (initUserDefaults,
//       claimWomenElite — no Stripe subscription, not a founder) → 'free':
//       identity Elite is now decided by how someone is matched
//     • entitlement computed for everyone (refreshPlayAccess)
//   trialHistory/{phoneHash}: existing trials and paid plans, by phone

import { createRequire } from 'node:module'

const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const lib = (name) => require(new URL(`../../functions/lib/${name}.js`, import.meta.url).pathname)
const isBot = (uid) => uid.startsWith('zbot-') || uid.startsWith('seed-')

export async function planStageC(db, { phoneOf = async () => null } = {}) {
  const { getLinkedCity, getNearestCity } = lib('cities')
  const plan = { pairs: [], matching: [], locations: [], internal: [], history: [], entitlementUids: [], counts: {} }
  const count = (k, n = 1) => (plan.counts[k] = (plan.counts[k] ?? 0) + n)

  for (const p of (await db.collection('pairs').get()).docs) {
    const d = p.data()
    if (d.sparkBreakdown === undefined && d.triggeredDealbreakers === undefined && d.tier1Spark === undefined) continue
    plan.pairs.push({ id: p.id, breakdown: d.sparkBreakdown ?? {}, dealbreakers: d.triggeredDealbreakers ?? [], tier1: d.tier1Spark ?? null })
    count('pair docs: report details moved to gated sub-docs')
  }

  for (const m of (await db.collectionGroup('private').get()).docs) {
    if (m.id !== 'matching') continue
    const r = m.get('radiusMiles')
    if (r === null || (typeof r === 'number' && r > 100)) {
      plan.matching.push(m.ref.path)
      count('distance settings capped at 100 miles')
    }
  }

  for (const l of (await db.collection('userLocations').get()).docs) {
    if (isBot(l.id)) continue
    const d = l.data()
    if (typeof d.marketCityId === 'string' && d.marketCityId) continue
    if (typeof d.linkedCityId === 'string' && d.linkedCityId) continue
    if (typeof d.lat !== 'number' || typeof d.lng !== 'number') continue
    const near = getNearestCity(d.lat, d.lng)
    if (near) continue // a launch city covers them; setLocation sets the market on their next save
    plan.locations.push({ uid: l.id, linkedCityId: getLinkedCity(d.lat, d.lng).id })
    count('users linked to their nearest major city')
  }

  const users = (await db.collection('users').get()).docs
  for (const u of users) {
    if (isBot(u.id)) continue
    const root = u.data()
    if (root.isDeleted === true) continue
    plan.entitlementUids.push(u.id)
    const internal = (await db.doc(`userInternal/${u.id}`).get()).data() ?? {}
    const patch = {}
    const status = internal.subscriptionStatus
    if ((status === 'canceled' || status === 'unpaid') && internal.hadPaidPlan !== true) {
      patch.hadPaidPlan = true
      count('cancelled subscribers marked (Free, no trial)')
    }
    const paying = status === 'active' || status === 'past_due'
    if (internal.subscriptionTier === 'elite' && !paying && root.isFounder !== true && (internal.subscriptionSource === undefined || internal.subscriptionSource === 'women_auto')) {
      patch.subscriptionTier = 'free'
      count('identity Elite stamps cleared (entitlement decides)')
    }
    if (Object.keys(patch).length) plan.internal.push({ uid: u.id, patch })
    if (internal.trialStartedAt || internal.hadPaidPlan || patch.hadPaidPlan || paying) {
      const phone = await phoneOf(u.id)
      if (phone) {
        plan.history.push({
          phone,
          fields: {
            ...(internal.trialStartedAt ? { trialStartedAt: internal.trialStartedAt, trialEndsAt: internal.trialEndsAt } : {}),
            ...(internal.hadPaidPlan || patch.hadPaidPlan || paying ? { hadPaidPlan: true } : {}),
          },
        })
        count('trial / paid history recorded by phone')
      }
    }
  }
  count('entitlements computed', plan.entitlementUids.length)
  return plan
}

export async function applyStageC({ db, FieldValue }, plan) {
  const writes = []
  for (const p of plan.pairs) {
    writes.push((b) => b.set(db.doc(`pairs/${p.id}/modes/spark`), { sparkBreakdown: p.breakdown, triggeredDealbreakers: p.dealbreakers }, { merge: true }))
    if (p.tier1) writes.push((b) => b.set(db.doc(`pairs/${p.id}/modes/deep`), { tier1Spark: p.tier1 }, { merge: true }))
    writes.push((b) => b.update(db.doc(`pairs/${p.id}`), { sparkBreakdown: FieldValue.delete(), triggeredDealbreakers: FieldValue.delete(), tier1Spark: FieldValue.delete() }))
  }
  for (const path of plan.matching) writes.push((b) => b.update(db.doc(path), { radiusMiles: 100 }))
  for (const l of plan.locations) writes.push((b) => b.set(db.doc(`userLocations/${l.uid}`), { linkedCityId: l.linkedCityId }, { merge: true }))
  for (const i of plan.internal) writes.push((b) => b.set(db.doc(`userInternal/${i.uid}`), i.patch, { merge: true }))
  const { phoneHash } = lib('trust')
  for (const h of plan.history) writes.push((b) => b.set(db.doc(`trialHistory/${phoneHash(h.phone)}`), { ...h.fields, updatedAt: FieldValue.serverTimestamp() }, { merge: true }))
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch()
    for (const w of writes.slice(i, i + 400)) w(batch)
    await batch.commit()
  }
  // Entitlements last, from the migrated data.
  const { refreshPlayAccess } = lib('playAccess')
  const tiers = {}
  for (const uid of plan.entitlementUids) {
    await refreshPlayAccess(uid)
    const t = (await db.doc(`userInternal/${uid}`).get()).get('entitlement')
    const k = `${t?.tier ?? 'none'} (${t?.source ?? '-'})`
    tiers[k] = (tiers[k] ?? 0) + 1
  }
  return { writes: writes.length, tiers }
}

// Preview of what each user's entitlement will be, without writing.
export async function previewEntitlements(db, plan) {
  const { computeEntitlement } = lib('entitlements')
  const linked = new Map(plan.locations.map((l) => [l.uid, l.linkedCityId]))
  const patches = new Map(plan.internal.map((i) => [i.uid, i.patch]))
  const tiers = {}
  for (const uid of plan.entitlementUids) {
    const [root, internal, matching, loc] = await Promise.all([
      db.doc(`users/${uid}`).get(),
      db.doc(`userInternal/${uid}`).get(),
      db.doc(`users/${uid}/private/matching`).get(),
      db.doc(`userLocations/${uid}`).get(),
    ])
    const e = computeEntitlement({
      root: root.data(),
      plan: { ...(internal.data() ?? {}), ...(patches.get(uid) ?? {}) },
      matching: matching.data() ?? { matchableAs: root.get('matchableAs') },
      loc: { ...(loc.data() ?? {}), ...(linked.has(uid) ? { linkedCityId: linked.get(uid) } : {}) },
    })
    const k = `${e.tier} (${e.source})`
    tiers[k] = (tiers[k] ?? 0) + 1
  }
  return tiers
}
