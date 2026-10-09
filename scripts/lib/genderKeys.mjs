// H2 (fresh-eyes review): stored genders rewritten to the app's keys. Used
// by scripts/migrate-gender-keys.mjs and the regression suite
// (e2e/tests/42-review-accounts.spec.mjs).
//
//   users/{uid}/private/matching   genderIdentity → its key (functions/lib/
//   users/{uid} (old copies)       gender.js normalizeGender — the readers'
//   deletedAccounts/{phone}        own code): "Woman" → woman, "cis woman" →
//                                  woman, "Non-binary" → nonbinary, a list →
//                                  its first entry's key, mobile-only options
//                                  (Two-spirit, Genderqueer…) → self_describe
//                                  (matched by matchableAs, as they were).
//                                  Values with no key are left alone and
//                                  counted: every reader now treats them alike
//                                  (no gender: matched by matchableAs).
//
// Counted, not changed:
//   • per raw value → key (values are gender labels, never names or ids)
//   • accounts whose identity Elite or Explore category changes: before = the
//     old identity.ts reading (lowercase / trim / a few aliases), after = the
//     shared one. "Lost identity Elite" are accounts that held it on a
//     spelling Explore matched another way.
//   • founders whose recorded bucket (founderRecords) differs from the one
//     their gender now gives — for a person to look at; spots aren't moved.
//
// After --apply, each changed account's entitlement is recomputed
// (refreshPlayAccess). Every doc changed is in `backup` first. Idempotent.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const lib = (name) => require(new URL(`../../functions/lib/${name}.js`, import.meta.url).pathname)
const { normalizeGender } = lib('gender')
const { categoriesOf, eliteByMatching } = lib('identity')

const isBot = (uid) => /^(zbot|seed)-/.test(uid)
const show = (v) => (v === undefined ? '(unset)' : JSON.stringify(v))

// The reading identity.ts used before (for the before/after counts only).
function oldCategories(genderIdentity, matchableAs) {
  const g = Array.isArray(genderIdentity) ? genderIdentity[0] : genderIdentity
  switch (typeof g === 'string' ? g.toLowerCase().trim() : g) {
    case 'man':
    case 'trans_man':
      return ['men']
    case 'woman':
    case 'trans_woman':
    case 'cis woman':
      return ['women']
    case 'nonbinary':
    case 'non_binary':
      return ['nonbinary_people']
    default:
      return Array.isArray(matchableAs) && matchableAs.length ? matchableAs.filter((x) => typeof x === 'string') : ['everyone']
  }
}
const oldElite = (g, m) => {
  const cats = oldCategories(g, m)
  return cats.length > 0 && cats.every((c) => c === 'women' || c === 'nonbinary_people')
}
// Explore's old reading: exact keys only.
function oldExplore(g, m) {
  const v = Array.isArray(g) ? g[0] : g
  if (v === 'man' || v === 'trans_man') return ['men']
  if (v === 'woman' || v === 'trans_woman') return ['women']
  if (v === 'nonbinary') return ['nonbinary_people']
  return Array.isArray(m) && m.length ? m.filter((x) => typeof x === 'string') : ['everyone']
}

// What a stored value becomes: undefined = leave it (already a key, unset,
// or no key for it).
function rewrite(v) {
  if (v === undefined || v === null) return undefined
  const key = normalizeGender(v)
  if (key === null || key === v) return undefined
  return key
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export async function planGenderKeys({ db }, { onlyUid = null } = {}) {
  const plan = { writes: [], refresh: [], backup: {}, values: {}, counts: {} }
  const count = (k, n = 1) => (plan.counts[k] = (plan.counts[k] ?? 0) + n)
  for (const k of [
    'private/matching: rewritten',
    'public doc (old copy): rewritten',
    'deletedAccounts: rewritten',
    'no key for the value (left; read as no gender everywhere)',
    'identity Elite: lost (held on a spelling Explore matched another way)',
    'identity Elite: gained',
    'Explore category changed',
    'founders: recorded bucket differs (report only)',
  ])
    plan.counts[k] = 0
  const keep = (snap) => {
    if (snap.exists) plan.backup[snap.ref.path] = snap.data()
  }
  const tally = (where, v) => {
    if (v === undefined || v === null) return
    const k = normalizeGender(v)
    const label = `${where}: ${show(v)} → ${k ?? '(no key)'}`
    plan.values[label] = (plan.values[label] ?? 0) + 1
    if (k === null) count('no key for the value (left; read as no gender everywhere)')
  }

  const users = onlyUid ? [await db.doc(`users/${onlyUid}`).get()].filter((s) => s.exists) : (await db.collection('users').get()).docs
  for (const u of users) {
    const uid = u.id
    const root = u.data()
    const matchingSnap = await db.doc(`users/${uid}/private/matching`).get()
    const m = matchingSnap.data() ?? {}
    tally('private/matching', m.genderIdentity)
    tally('public doc', root.genderIdentity)
    const mNew = rewrite(m.genderIdentity)
    const rNew = rewrite(root.genderIdentity)
    if (mNew !== undefined) {
      keep(matchingSnap)
      plan.writes.push({ path: matchingSnap.ref.path, value: mNew })
      count('private/matching: rewritten')
    }
    if (rNew !== undefined) {
      keep(u)
      plan.writes.push({ path: u.ref.path, value: rNew })
      count('public doc (old copy): rewritten')
    }
    if (root.isDeleted === true || isBot(uid)) continue
    // How they're matched, before and after (private value first, as the readers do).
    const g = m.genderIdentity ?? root.genderIdentity
    const matchableAs = m.matchableAs ?? root.matchableAs
    const locked = root.identityLockedAt != null
    const before = locked && oldElite(g, matchableAs)
    const after = locked && eliteByMatching(g, matchableAs)
    if (before && !after) count('identity Elite: lost (held on a spelling Explore matched another way)')
    if (!before && after) count('identity Elite: gained')
    if (JSON.stringify(oldExplore(g, matchableAs)) !== JSON.stringify(categoriesOf(g, matchableAs))) count('Explore category changed')
    if (mNew !== undefined || rNew !== undefined || before !== after) plan.refresh.push(uid)
    if (root.isFounder === true) {
      const rec = (await db.doc(`founderRecords/${uid}`).get()).data()
      const bucket = eliteByMatching(g, matchableAs) ? 'women' : 'men'
      if (rec?.bucket && rec.bucket !== bucket) count('founders: recorded bucket differs (report only)')
    }
  }

  if (!onlyUid) {
    for (const d of (await db.collection('deletedAccounts').get()).docs) {
      tally('deletedAccounts', d.get('genderIdentity'))
      const v = rewrite(d.get('genderIdentity'))
      if (v === undefined) continue
      keep(d)
      plan.writes.push({ path: d.ref.path, value: v })
      count('deletedAccounts: rewritten')
    }
  }
  return plan
}

export function summaryGenderKeys(plan) {
  return {
    ...plan.counts,
    'entitlements to recompute after the rewrite': plan.refresh.length,
    'docs backed up before any write': Object.keys(plan.backup).length,
  }
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export async function applyGenderKeys({ db }, plan) {
  for (let i = 0; i < plan.writes.length; i += 400) {
    const batch = db.batch()
    for (const w of plan.writes.slice(i, i + 400)) batch.update(db.doc(w.path), { genderIdentity: w.value })
    await batch.commit()
  }
  // The entitlement follows how they're now matched (the gender change alone
  // doesn't trigger it: entitlementOnMatching watches matchableAs).
  const { refreshPlayAccess } = lib('playAccess')
  for (const uid of plan.refresh) await refreshPlayAccess(uid)
  return plan.writes.length
}
