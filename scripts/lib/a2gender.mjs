// §4.A2: gender off the public doc. Used by scripts/migrate-a2-gender.mjs
// and the regression suite (e2e/tests/36-a2-hidden-gender.spec.mjs,
// e2e/tests/helpers.mjs seedUser).
//
//   users/{uid}              genderIdentity, genderSelfDescribe, pronouns,
//                            genderHidden, showGender → private/matching (a
//                            value already there wins, as in §4.A1), then
//                            deleted from the public doc; the public doc gets
//                            the server-built genderLine (functions/lib/
//                            genderLine.js — the trigger's own code).
//                            Deleted accounts: the fields are only deleted
//                            (nothing moves, no line). Curated profiles
//                            (zbot-/seed-) move too, so every reader finds
//                            the gender in one place.
//   sparkProfile/data,       their copies of the gender fields deleted (the
//   playProfile/data,        first two are owner-only now; playProfiles is
//   playProfiles/{playId}    the public Play copy and should have none)
//
// Reported, not changed: accounts with a gender and no identity lock. The
// move itself sets their lock: identityGuardOnMatching locks identity on the
// first gender written to private/matching.
//
// Every doc changed is returned in `backup` (path → data) before anything is
// written; migrate-a2-gender.mjs saves it. Idempotent.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const lib = (name) => require(new URL(`../../functions/lib/${name}.js`, import.meta.url).pathname)
const { buildGenderLine } = lib('genderLine')
const { GENDER_FIELDS } = lib('userData')

// What sub-docs may carry (mobile wrote gender into both profile docs).
const SUBDOC_FIELDS = ['genderIdentity', 'genderSelfDescribe', 'pronouns', 'genderHidden', 'showGender']
const isBot = (uid) => /^(zbot|seed)-/.test(uid)
const genderOfDocs = (m, root) => m.genderIdentity ?? root.genderIdentity

// ─── Plan ────────────────────────────────────────────────────────────────────

// onlyUid: plan one account (the suite's seeding); otherwise every account.
export async function planA2({ db }, { onlyUid = null } = {}) {
  const plan = { users: [], subdocs: [], unlocked: 0, backup: {}, counts: {} }
  const count = (k, n = 1) => (plan.counts[k] = (plan.counts[k] ?? 0) + n)
  for (const f of GENDER_FIELDS) for (const k of ['on public doc', 'moved', 'conflict (private value kept)']) plan.counts[`${f}: ${k}`] = 0
  const keep = (snap) => {
    if (snap.exists) plan.backup[snap.ref.path] = snap.data()
  }

  const users = onlyUid ? [await db.doc(`users/${onlyUid}`).get()].filter((s) => s.exists) : (await db.collection('users').get()).docs
  for (const u of users) {
    const uid = u.id
    const root = u.data()
    const matchingSnap = await db.doc(`users/${uid}/private/matching`).get()
    const m = matchingSnap.data() ?? {}
    const deleted = root.isDeleted === true
    const onRoot = GENDER_FIELDS.filter((f) => root[f] !== undefined)
    const toMatching = {}
    if (!deleted) {
      for (const f of onRoot) {
        count(`${f}: on public doc`)
        if (m[f] === undefined) {
          toMatching[f] = root[f]
          count(`${f}: moved`)
        } else count(`${f}: conflict (private value kept)`)
      }
    }
    const line = deleted ? undefined : buildGenderLine({ ...m, ...toMatching })
    const writeLine = !deleted && root.genderLine !== line
    const scrubLine = deleted && root.genderLine !== undefined
    if (!onRoot.length && !writeLine && !scrubLine) continue
    keep(u)
    if (Object.keys(toMatching).length) keep(matchingSnap)
    plan.users.push({ uid, toMatching, scrub: onRoot, genderLine: writeLine ? line : scrubLine ? null : undefined })
    if (deleted) count('deleted accounts: gender fields deleted')
    else if (onRoot.length) count(isBot(uid) ? 'curated profiles moved' : 'accounts moved off the public doc')
    if (Object.keys(toMatching).length) count('private/matching docs written')
    if (writeLine) count(line ? 'genderLine written (non-empty)' : 'genderLine written (empty)')
    if (!deleted && genderOfDocs(m, root) != null && root.identityLockedAt == null && !isBot(uid)) plan.unlocked++
  }

  const groups = onlyUid
    ? [
        await db.doc(`users/${onlyUid}/sparkProfile/data`).get(),
        await db.doc(`users/${onlyUid}/playProfile/data`).get(),
      ].filter((s) => s.exists)
    : [
        ...(await db.collectionGroup('sparkProfile').get()).docs,
        ...(await db.collectionGroup('playProfile').get()).docs,
        ...(await db.collection('playProfiles').get()).docs,
      ]
  for (const d of groups) {
    const fields = SUBDOC_FIELDS.filter((f) => d.get(f) !== undefined)
    if (!fields.length) continue
    keep(d)
    plan.subdocs.push({ path: d.ref.path, fields })
    const group = d.ref.parent.id === 'playProfiles' ? 'playProfiles' : d.ref.parent.id
    count(`${group} copies scrubbed`)
  }
  return plan
}

export function summaryA2(plan) {
  return {
    ...plan.counts,
    'report: accounts with a gender and no identity lock (the move locks them)': plan.unlocked,
    'docs backed up before any write': Object.keys(plan.backup).length,
  }
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export async function applyA2({ db, FieldValue }, plan) {
  const writes = []
  for (const u of plan.users) {
    if (Object.keys(u.toMatching).length) writes.push((b) => b.set(db.doc(`users/${u.uid}/private/matching`), u.toMatching, { merge: true }))
    const patch = Object.fromEntries(u.scrub.map((f) => [f, FieldValue.delete()]))
    if (u.genderLine === null) patch.genderLine = FieldValue.delete()
    else if (u.genderLine !== undefined) patch.genderLine = u.genderLine
    if (Object.keys(patch).length) writes.push((b) => b.update(db.doc(`users/${u.uid}`), patch))
  }
  for (const s of plan.subdocs) writes.push((b) => b.update(db.doc(s.path), Object.fromEntries(s.fields.map((f) => [f, FieldValue.delete()]))))
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch()
    for (const w of writes.slice(i, i + 400)) w(batch)
    await batch.commit()
  }
  return writes.length
}

// One account (the suite's seeding: users are seeded in the old layout).
export async function migrateUserA2({ db, FieldValue }, uid) {
  return applyA2({ db, FieldValue }, await planA2({ db }, { onlyUid: uid }))
}
