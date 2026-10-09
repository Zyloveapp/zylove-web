// Dealbreakers out of seekingPreferences. Used by
// scripts/migrate-dealbreakers.mjs and the regression suite
// (e2e/tests/39-dealbreakers-source.spec.mjs).
//
//   users/{uid}/seekingPreferences/{doc}.dealbreakers
//       Older web builds saved the dealbreakers here; scoring reads them only
//       from private/matching, so they never took effect. Per account
//       (functions/lib/dealbreakerMove.js — tested in functions/test):
//       - nothing in effect (private/matching's list absent, null or [], and
//         no public-doc copy): copied to private/matching — scoring keys only,
//         sorted — as a first value: no fieldChangedAt stamp, so no 30-day
//         clock starts (it never took effect);
//       - the same list already in effect: nothing to copy;
//       - a different list in effect, or one cleared under the 30-day limit
//         (stamped): the private one is kept — it's what the person sees and
//         what scoring has used — and counted as a conflict;
//       - deleted or missing accounts: nothing copied.
//       The field is then removed from every seekingPreferences doc,
//       conflicts included: it's dead data, and the rules now refuse it there.
//
// Copying into private/matching fires onMatchingPrefsWrite, which re-scores
// that person's pairs: the migration re-scores the accounts it copies for.
//
// Every doc changed is returned in `backup` (path → data) before anything is
// written; migrate-dealbreakers.mjs saves it. Idempotent: a second run finds
// no field to move.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const { planDealbreakerMove } = require(new URL('../../functions/lib/dealbreakerMove.js', import.meta.url).pathname)

const COUNTS = [
  'accounts with seekingPreferences dealbreakers',
  'copied to private/matching (first value, no stamp)',
  'identical already (nothing to copy)',
  'conflicts: a different list in effect (private value kept)',
  'conflicts: cleared under the 30-day limit (kept)',
  'empty lists skipped (nothing valid to copy)',
  'deleted or missing accounts (nothing copied)',
  'invalid values dropped (not scoring keys)',
  'seekingPreferences docs losing the field',
]

// ─── Plan ────────────────────────────────────────────────────────────────────

export async function planDealbreakers({ db }) {
  const plan = { accounts: [], backup: {}, counts: Object.fromEntries(COUNTS.map((k) => [k, 0])) }
  const count = (k, n = 1) => (plan.counts[k] += n)
  const keep = (snap) => {
    if (snap.exists) plan.backup[snap.ref.path] = snap.data()
  }

  // Docs carrying the field, grouped by account (normally just …/prefs).
  const byUid = new Map()
  for (const d of (await db.collectionGroup('seekingPreferences').get()).docs) {
    const owner = d.ref.parent.parent
    if (d.get('dealbreakers') === undefined || owner?.parent.id !== 'users') continue
    byUid.set(owner.id, [...(byUid.get(owner.id) ?? []), d])
  }

  for (const [uid, docs] of byUid) {
    count('accounts with seekingPreferences dealbreakers')
    const [rootSnap, matchingSnap] = await Promise.all([db.doc(`users/${uid}`).get(), db.doc(`users/${uid}/private/matching`).get()])
    const prefs = docs.find((d) => d.id === 'prefs') ?? docs[0]
    const move = planDealbreakerMove(prefs.get('dealbreakers'), matchingSnap.data(), rootSnap.data())
    count('invalid values dropped (not scoring keys)', move.dropped)
    const live = rootSnap.exists && rootSnap.get('isDeleted') !== true
    let copy = null
    if (move.action === 'empty') count('empty lists skipped (nothing valid to copy)')
    else if (!live) count('deleted or missing accounts (nothing copied)')
    else if (move.action === 'copy') {
      copy = move.value
      count('copied to private/matching (first value, no stamp)')
    } else if (move.action === 'identical') count('identical already (nothing to copy)')
    else count(move.stamped ? 'conflicts: cleared under the 30-day limit (kept)' : 'conflicts: a different list in effect (private value kept)')

    if (copy) keep(matchingSnap)
    docs.forEach(keep)
    count('seekingPreferences docs losing the field', docs.length)
    plan.accounts.push({ uid, copy, scrub: docs.map((d) => d.ref.path) })
  }
  return plan
}

export function summaryDealbreakers(plan) {
  return { ...plan.counts, 'docs backed up before any write': Object.keys(plan.backup).length }
}

// ─── Apply ───────────────────────────────────────────────────────────────────

// An account's copy and removals go in the same batch.
export async function applyDealbreakers({ db, FieldValue }, plan) {
  let n = 0
  for (let i = 0; i < plan.accounts.length; i += 100) {
    const batch = db.batch()
    for (const a of plan.accounts.slice(i, i + 100)) {
      if (a.copy) {
        batch.set(db.doc(`users/${a.uid}/private/matching`), { dealbreakers: a.copy }, { merge: true })
        n++
      }
      for (const path of a.scrub) {
        batch.update(db.doc(path), { dealbreakers: FieldValue.delete() })
        n++
      }
    }
    await batch.commit()
  }
  return n
}
