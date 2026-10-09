// Body-type, trait and height preferences out of seekingPreferences. Used by
// scripts/migrate-seeking-prefs.mjs and the regression suite
// (e2e/tests/44-seeking-prefs.spec.mjs).
//
//   users/{uid}/seekingPreferences/{doc}.seekingBodyTypes / seekingTraits /
//   seekingHeightMinCm + seekingHeightMaxCm
//       Older web builds saved them here; scoring reads them only from
//       private/matching, so they never took effect. Per account and per
//       field (the height range is one field: both ends move together)
//       (functions/lib/seekingMove.js — tested in functions/test):
//       - nothing in effect (private/matching's value absent, null or [], no
//         public-doc copy; for the height, not both ends): copied to
//         private/matching (scoring keys only — no rate limit applies);
//       - the same value already in effect: nothing to copy;
//       - a different value in effect: the private one is kept — it's what
//         scoring has used — and counted as a conflict;
//       - nothing valid ([] , junk, a reversed or impossible range, or the
//         range with "Doesn't matter" ticked): nothing to copy;
//       - deleted or missing accounts: nothing copied.
//       The moved keys are then removed from every seekingPreferences doc,
//       conflicts included: they're dead data, and the rules now refuse them
//       there. The "Doesn't matter" flags stay (the editor still uses them).
//
// Copying into private/matching fires onMatchingPrefsWrite, which re-scores
// that person's pairs when a body type or height range was copied (traits
// aren't scored, so a traits-only copy re-scores nothing).
//
// Every doc changed is returned in `backup` (path → data) before anything is
// written; migrate-seeking-prefs.mjs saves it. Idempotent: a second run finds
// no field to move.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const { planSeekingMove, SEEKING_MOVE_FIELDS, SEEKING_MOVE_KEYS } = require(new URL('../../functions/lib/seekingMove.js', import.meta.url).pathname)

const LABEL = { seekingBodyTypes: 'body types', seekingTraits: 'traits', seekingHeight: 'height range' }
const PER_FIELD = [
  ['present', 'accounts with one'],
  ['copy', 'copied to private/matching'],
  ['identical', 'identical already (nothing to copy)'],
  ['conflict', 'conflicts: a different value in effect (private kept)'],
  ['empty', 'empty or no preference (nothing to copy)'],
  ['gone', 'deleted or missing accounts (nothing copied)'],
  ['dropped', 'invalid values dropped'],
]
const key = (f, k) => `${LABEL[f]}: ${PER_FIELD.find(([id]) => id === k)[1]}`
const COUNTS = [
  'accounts with seekingPreferences body types, traits or height',
  ...SEEKING_MOVE_FIELDS.flatMap((f) => PER_FIELD.map(([k]) => key(f, k))),
  'seekingPreferences docs losing fields',
]

// ─── Plan ────────────────────────────────────────────────────────────────────

export async function planSeekingPrefs({ db }) {
  const plan = { accounts: [], backup: {}, counts: Object.fromEntries(COUNTS.map((k) => [k, 0])) }
  const count = (k, n = 1) => (plan.counts[k] += n)
  const keep = (snap) => {
    if (snap.exists) plan.backup[snap.ref.path] = snap.data()
  }

  // Docs carrying any moved key, grouped by account (normally just …/prefs).
  const byUid = new Map()
  for (const d of (await db.collectionGroup('seekingPreferences').get()).docs) {
    const owner = d.ref.parent.parent
    if (!SEEKING_MOVE_KEYS.some((k) => d.get(k) !== undefined) || owner?.parent.id !== 'users') continue
    byUid.set(owner.id, [...(byUid.get(owner.id) ?? []), d])
  }

  for (const [uid, docs] of byUid) {
    count('accounts with seekingPreferences body types, traits or height')
    const [rootSnap, matchingSnap] = await Promise.all([db.doc(`users/${uid}`).get(), db.doc(`users/${uid}/private/matching`).get()])
    const prefs = docs.find((d) => d.id === 'prefs') ?? docs[0]
    const moves = planSeekingMove(prefs.data(), matchingSnap.data(), rootSnap.data())
    const live = rootSnap.exists && rootSnap.get('isDeleted') !== true
    const copy = {}
    for (const f of SEEKING_MOVE_FIELDS) {
      const m = moves[f]
      if (m.action === 'absent') continue
      count(key(f, 'present'))
      count(key(f, 'dropped'), m.dropped)
      if (m.action === 'empty') count(key(f, 'empty'))
      else if (!live) count(key(f, 'gone'))
      else {
        count(key(f, m.action))
        if (m.action === 'copy') Object.assign(copy, m.value)
      }
    }

    const hasCopy = Object.keys(copy).length > 0
    if (hasCopy) keep(matchingSnap)
    docs.forEach(keep)
    count('seekingPreferences docs losing fields', docs.length)
    plan.accounts.push({
      uid,
      copy: hasCopy ? copy : null,
      scrub: docs.map((d) => ({ path: d.ref.path, keys: SEEKING_MOVE_KEYS.filter((k) => d.get(k) !== undefined) })),
    })
  }
  return plan
}

export function summarySeekingPrefs(plan) {
  return { ...plan.counts, 'docs backed up before any write': Object.keys(plan.backup).length }
}

// ─── Apply ───────────────────────────────────────────────────────────────────

// An account's copy and removals go in the same batch.
export async function applySeekingPrefs({ db, FieldValue }, plan) {
  let n = 0
  for (let i = 0; i < plan.accounts.length; i += 100) {
    const batch = db.batch()
    for (const a of plan.accounts.slice(i, i + 100)) {
      if (a.copy) {
        batch.set(db.doc(`users/${a.uid}/private/matching`), a.copy, { merge: true })
        n++
      }
      for (const { path, keys } of a.scrub) {
        batch.update(db.doc(path), Object.fromEntries(keys.map((k) => [k, FieldValue.delete()])))
        n++
      }
    }
    await batch.commit()
  }
  return n
}
