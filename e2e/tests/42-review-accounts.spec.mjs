// Fresh-eyes review (2026-10-09), accounts and entitlements:
//   H1  free Elite with no end by never calling initUserDefaults — the trial,
//       the phone's trial history and the account's age are now the server's
//       (accountDefaults.ts); an open city with no trial is never pre-launch;
//       probation treats a missing account age as new
//   H2  non-standard gender spellings — one normaliser (gender.ts) for
//       identity Elite, founders, Explore, scoring and the line; the rules
//       take only the app's keys; scripts/lib/genderKeys.mjs migrates
//   H6  delete then restore — blocks re-keyed both ways, the scam hold
//       carried, a restore refused while reports are pending, and admin
//       actions on the old uid reaching the restored account
// Each attack is set up as it was possible before, then shown blocked.
import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import {
  resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, adminAuth, fnLib, sortedPair, internalDoc, userDoc, setPlan, Timestamp, FieldValue, PROJECT,
} from './helpers.mjs'
import { applyGenderKeys, planGenderKeys, summaryGenderKeys } from '../../scripts/lib/genderKeys.mjs'
import { applyAccountDefaults, planAccountDefaults } from '../../scripts/lib/accountDefaults.mjs'

test.beforeEach(resetEmulators)

const DAY = 864e5
const errOf = (p) => p.then(() => null, (e) => String(e.message))
const woman = (name, o = {}) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o })
const ent = async (uid) => (await internalDoc(uid))?.entitlement ?? null
const openAustin = () => db.doc('config/city_austin').set({ discoveryOpenedAt: Timestamp.now(), botsActive: false }, { merge: true })
const phoneKey = (phone) => fnLib('trust').phoneHash(phone)

// ─── H1 ───────────────────────────────────────────────────────────────────────

test('H1: in an open city, an account that never calls initUserDefaults gets its trial and age from the server — never open-ended pre-launch', async () => {
  await openAustin()
  const hal = await seedUser('Hal') // a man in Austin; the app never calls initUserDefaults
  // The attack: before, the entitlement in an open market with no trial was
  // Elite "pre-launch" with no end — what the old code (no marketOpen) says.
  const loc = (await db.doc(`userLocations/${hal.uid}`).get()).data()
  const old = fnLib('entitlements').computeEntitlement({ root: await userDoc(hal.uid), plan: {}, matching: { genderIdentity: 'man' }, loc })
  expect(old).toMatchObject({ tier: 'elite', source: 'prelaunch', until: null })
  // Now: the server starts the trial itself (with an end), records the
  // account's age and puts the trial on record by phone.
  await expect.poll(async () => (await ent(hal.uid))?.source ?? null, { timeout: 30000 }).toBe('trial')
  const n = await internalDoc(hal.uid)
  expect(n.entitlement.until.toMillis()).toBeGreaterThan(Date.now() + 29 * DAY)
  expect(typeof n.accountCreatedAt).toBe('number')
  expect(Math.abs(n.accountCreatedAt - Date.now())).toBeLessThan(5 * 60 * 1000)
  expect((await userDoc(hal.uid)).memberSince).toMatch(/^\d{4}-\d{2}$/)
  expect(typeof (await userDoc(hal.uid)).newUntil).toBe('number')
  const history = (await db.doc(`trialHistory/${phoneKey(hal.phone)}`).get()).data()
  expect(history.trialStartedAt.toMillis()).toBe(n.trialStartedAt.toMillis())

  // With no trial to start (this phone paid before), an open city is Free
  // ("waiting") — never Elite pre-launch.
  const pia = await seedUser('Pia')
  await expect.poll(async () => (await ent(pia.uid))?.source ?? null, { timeout: 30000 }).toBe('trial')
  await db.doc(`trialHistory/${phoneKey(pia.phone)}`).set({ hadPaidPlan: true }, { merge: true })
  await db.doc(`userInternal/${pia.uid}`).update({ trialStartedAt: FieldValue.delete(), trialEndsAt: FieldValue.delete(), trialExpired: FieldValue.delete() })
  await expect.poll(async () => (await internalDoc(pia.uid)).hadPaidPlan ?? null, { timeout: 30000 }).toBe(true)
  await fnLib('playAccess').refreshPlayAccess(pia.uid)
  expect(await ent(pia.uid)).toMatchObject({ tier: 'free', source: 'free' })
  expect((await internalDoc(pia.uid)).trialStartedAt).toBeUndefined()
})

test('H1: signing up again with a used phone gets the old trial back, never a new one', async () => {
  await openAustin()
  const ivy = await seedUser('Ivy')
  await expect.poll(async () => (await ent(ivy.uid))?.source ?? null, { timeout: 30000 }).toBe('trial')
  // Her trial ran out long ago (as recorded by phone), then she deletes.
  const ended = { trialStartedAt: Timestamp.fromMillis(Date.now() - 40 * DAY), trialEndsAt: Timestamp.fromMillis(Date.now() - 10 * DAY) }
  await db.doc(`trialHistory/${phoneKey(ivy.phone)}`).set(ended, { merge: true })
  await callAs(ivy.uid, 'deleteAccount')
  await db.doc(`deletedAccounts/${ivy.phone}`).delete() // a fresh sign-up, not a restore

  // Same phone, new account in Austin; the app never calls initUserDefaults.
  const again = 'e2e-ivy-again'
  await adminAuth.createUser({ uid: again, phoneNumber: ivy.phone })
  await db.doc(`users/${again}`).set({ uid: again, displayName: 'Ivy', age: 30, onboardingComplete: true, photoURLs: [] })
  await db.doc(`userLocations/${again}`).set({ lat: 30.25, lng: -97.75, marketCityId: 'austin', changes: [] })
  await expect.poll(async () => (await internalDoc(again))?.trialStartedAt?.toMillis() ?? null, { timeout: 30000 }).toBe(ended.trialStartedAt.toMillis())
  const n = await internalDoc(again)
  expect(n.trialExpired).toBe(true)
  await expect.poll(async () => (await ent(again))?.tier ?? null, { timeout: 30000 }).toBe('free')
  // …and calling initUserDefaults changes nothing.
  await callAs(again, 'initUserDefaults')
  expect((await internalDoc(again)).trialStartedAt.toMillis()).toBe(ended.trialStartedAt.toMillis())
  expect((await ent(again)).tier).toBe('free')
})

test('H1: probation — the server records the account age, and a missing one counts as new', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const una = await seedUser('Una')
  const oli = await seedUser('Oli')
  // Recorded by the server without initUserDefaults.
  for (const p of [una, oli]) await expect.poll(async () => typeof (await internalDoc(p.uid))?.accountCreatedAt, { timeout: 30000 }).toBe('number')
  // Both on the free plan (a finished trial), set as the server decides it.
  for (const p of [una, oli]) await setPlan(p.uid, 'free')
  await db.doc(`userInternal/${oli.uid}`).set({ accountCreatedAt: Date.now() - 30 * DAY }, { merge: true })
  await callAs(admin.uid, 'adminSetProbation', { cityId: 'austin', enabled: true, reason: 'spam wave in Austin' })
  expect((await callAs(oli.uid, 'getUsage')).usage.likes.limit).toBe(10) // 30 days old
  expect((await callAs(una.uid, 'getUsage')).usage.likes.limit).toBe(5) // new
  // The attack: an account with no recorded age (it never called
  // initUserDefaults, before the server filled it in) was never on probation.
  await db.doc(`userInternal/${una.uid}`).update({ accountCreatedAt: FieldValue.delete() })
  expect((await internalDoc(una.uid)).accountCreatedAt).toBeUndefined()
  expect((await callAs(una.uid, 'getUsage')).usage.likes.limit).toBe(5)
})

// Background triggers off (the emulator hub's switch) while a test sets up
// data as the old, deployed code left it.
const triggers = (on) => fetch(`http://127.0.0.1:4610/functions/${on ? 'enable' : 'disable'}BackgroundTriggers`, { method: 'PUT' })

test('H1: the backfill finds open-ended pre-launch in an open city and fixes it; idempotent', async () => {
  const a = await seedUser('Abe')
  const b = await seedUser('Bea', { genderIdentity: 'woman', attractedTo: ['men'] })
  for (const p of [a, b]) await expect.poll(async () => (await ent(p.uid))?.source ?? null, { timeout: 30000 }).toMatch(/prelaunch|identity/)
  await expect.poll(async () => (await ent(b.uid))?.source ?? null, { timeout: 30000 }).toBe('identity')
  await expect.poll(async () => typeof (await internalDoc(a.uid))?.accountCreatedAt, { timeout: 30000 }).toBe('number')
  await new Promise((r) => setTimeout(r, 2000))
  const authOf = async (uids) => new Map(await Promise.all(uids.map(async (u) => {
    const r = await adminAuth.getUser(u).catch(() => null)
    return [u, { phone: r?.phoneNumber ?? null, createdAt: r ? Date.parse(r.metadata.creationTime) : null }]
  })))
  // The scripts read through the functions' own firebase-admin (as in
  // production), so Timestamps they read are the functions' class.
  fnLib('playAccess')
  const fdb = createRequire(new URL('../web-fn/package.json', import.meta.url).pathname)('firebase-admin/firestore').getFirestore()
  await triggers(false)
  try {
    // As the old code left it: the city opened, Abe never got a trial (his
    // app never called initUserDefaults) or an account age, and his stored
    // plan is Elite pre-launch with no end.
    await openAustin()
    await db.doc(`userInternal/${a.uid}`).update({ accountCreatedAt: FieldValue.delete() })
    expect((await ent(a.uid))).toMatchObject({ tier: 'elite', source: 'prelaunch', until: null })
    expect((await internalDoc(a.uid)).trialStartedAt).toBeUndefined()
    const plan = await planAccountDefaults(fdb, { authOf, onlyUids: [a.uid, b.uid] })
    expect(plan.counts['stored Elite pre-launch while their city is open (the H1 hole)']).toBe(1)
    expect(plan.counts['missing accountCreatedAt']).toBe(1)
    expect(plan.counts['trial: new (open city, phone never had one)']).toBe(1)
    expect(plan.before).toMatchObject({ 'elite (prelaunch)': 1, 'elite (identity)': 1 })
    expect(plan.after).toMatchObject({ 'elite (trial)': 1, 'elite (identity)': 1 })
    await applyAccountDefaults(plan)
    const n = await internalDoc(a.uid)
    expect(n.entitlement.source).toBe('trial')
    expect(n.entitlement.until.toMillis()).toBeGreaterThan(Date.now() + 29 * DAY)
    expect(typeof n.accountCreatedAt).toBe('number')
    expect((await db.doc(`trialHistory/${phoneKey(a.phone)}`).get()).exists).toBe(true)
    const again = await planAccountDefaults(fdb, { authOf, onlyUids: [a.uid, b.uid] })
    expect(again.uids).toEqual([])
    expect(again.refresh).toEqual([])
  } finally {
    await triggers(true)
  }
})

// ─── H2 ───────────────────────────────────────────────────────────────────────

const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
const value = (v) => (Array.isArray(v) ? { arrayValue: { values: v.map(value) } } : typeof v === 'boolean' ? { booleanValue: v } : { stringValue: v })
async function patch(uid, path, o) {
  const mask = Object.keys(o).map((k) => `updateMask.fieldPaths=${k}`).join('&')
  const r = await fetch(`${BASE}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)])) }),
  })
  return r.status
}
const SPELLINGS = ['Woman', 'cis woman', ' woman', ['Woman'], ['woman'], 'non_binary', 'Non-binary', 'WOMAN', 'woman ', 'female']

test('H2: the rules take only the app\'s gender keys — every other spelling is refused, on create and on change', async () => {
  const n = await seedUser('Nate', { genderIdentity: null, matchableAs: [] })
  await db.doc(`users/${n.uid}`).update({ identityLockedAt: FieldValue.delete() })
  await expect.poll(async () => (await userDoc(n.uid)).identityLockedAt ?? null).toBe(null)
  for (const g of SPELLINGS) expect(await patch(n.uid, `users/${n.uid}/private/matching`, { genderIdentity: g, matchableAs: ['men'] }), JSON.stringify(g)).toBe(403)
  // A fresh doc (create) too.
  await db.doc(`users/${n.uid}/private/matching`).delete()
  for (const g of SPELLINGS) expect(await patch(n.uid, `users/${n.uid}/private/matching`, { genderIdentity: g }), JSON.stringify(g)).toBe(403)
  expect((await db.doc(`users/${n.uid}/private/matching`).get()).exists).toBe(false)
  // A key is fine (and locks identity, as before).
  expect(await patch(n.uid, `users/${n.uid}/private/matching`, { genderIdentity: 'man', matchableAs: [] })).toBe(200)
  await expect.poll(async () => (await userDoc(n.uid)).identityLockedAt != null, { timeout: 20000 }).toBe(true)
  // An older stored spelling doesn't block saving other preferences.
  await db.doc(`users/${n.uid}/private/matching`).update({ genderIdentity: 'Man' })
  expect(await patch(n.uid, `users/${n.uid}/private/matching`, { pronouns: 'he/him' })).toBe(200)
})

test('H2: an account Explore matches as a man never gets identity Elite or a women\'s founder spot, however its gender is spelled', async () => {
  const viewer = await woman('Vera') // a woman attracted to men
  for (const g of ['Woman', 'cis woman', ' woman', ['Woman'], 'Non-binary', 'female']) {
    // The attack, as stored before the rules allow-list: a man's account
    // with an odd spelling, matched as men, he/him.
    const m = await seedUser(`M${SPELLINGS.indexOf(g) + 1}x`, { pronouns: 'he/him' })
    await db.doc(`users/${m.uid}/private/matching`).update({ genderIdentity: g, matchableAs: ['men'], pronouns: 'he/him' })
    await fnLib('explore').refreshEntry(m.uid)
    await fnLib('playAccess').refreshPlayAccess(m.uid)
    const cats = (await db.doc(`exploreIndex/${m.uid}`).get()).data()?.cats
    const e = await ent(m.uid)
    // One reading everywhere: Elite by identity only if Explore matches them
    // as women or nonbinary people — never while matched as men.
    expect(cats, JSON.stringify(g)).toBeDefined()
    if (e.source === 'identity') expect(cats.every((c) => c === 'women' || c === 'nonbinary_people'), JSON.stringify(g)).toBe(true)
    if (cats.includes('men')) expect(e.source, JSON.stringify(g)).not.toBe('identity')
    // Founders: the same half Explore and the entitlement say (F-114: a
    // day-old account).
    await db.doc(`userInternal/${m.uid}`).set({ accountCreatedAt: Date.now() - 2 * 864e5 }, { merge: true })
    const r = await callAs(m.uid, 'assignFounderBadge')
    const bucket = (await db.doc(`founderRecords/${m.uid}`).get()).data()?.bucket
    if (r.eligible !== false) expect(bucket, JSON.stringify(g)).toBe(e.source === 'identity' ? 'women' : 'men')
    if (cats.includes('men')) expect(bucket ?? 'men').toBe('men')
    // The man-spelled-as-woman case: Explore and scoring treat them as a woman
    // (so a woman attracted to men doesn't see them), not as a man.
    if (g !== 'female') {
      expect(cats).not.toContain('men')
      const deck = (await callAs(viewer.uid, 'getExploreDeck', { mode: 'spark' })).cards.map((c) => c.uid)
      expect(deck, JSON.stringify(g)).not.toContain(m.uid)
    } else {
      // No key: matched by matchableAs (men) everywhere — and so no Elite.
      expect(cats).toEqual(['men'])
      expect(e.source).not.toBe('identity')
    }
  }
})

test('H2: the migration rewrites stored spellings to keys (counts per raw value), recomputes the entitlement; idempotent', async () => {
  const a = await seedUser('Ann', { genderIdentity: 'woman', attractedTo: ['men'] })
  const b = await seedUser('Bob')
  const c = await seedUser('Cal', { genderIdentity: 'agender', matchableAs: ['women'] })
  await db.doc(`users/${a.uid}/private/matching`).update({ genderIdentity: ['Woman', 'Man'] })
  await db.doc(`users/${b.uid}/private/matching`).update({ genderIdentity: 'cis woman', matchableAs: ['men'] })
  await db.doc(`users/${c.uid}/private/matching`).update({ genderIdentity: 'Two-spirit' })
  await db.doc('deletedAccounts/+15550000001').set({ genderIdentity: 'Non-binary', previousUid: 'gone' })
  const plan = await planGenderKeys({ db })
  expect(plan.values['private/matching: ["Woman","Man"] → woman']).toBe(1)
  expect(plan.values['private/matching: "cis woman" → woman']).toBe(1)
  expect(plan.values['private/matching: "Two-spirit" → self_describe']).toBe(1)
  expect(plan.values['deletedAccounts: "Non-binary" → nonbinary']).toBe(1)
  const sum = summaryGenderKeys(plan)
  expect(sum['private/matching: rewritten']).toBe(3)
  expect(sum['deletedAccounts: rewritten']).toBe(1)
  await applyGenderKeys({ db }, plan)
  const g = async (u) => (await db.doc(`users/${u}/private/matching`).get()).get('genderIdentity')
  expect(await g(a.uid)).toBe('woman')
  expect(await g(b.uid)).toBe('woman')
  expect(await g(c.uid)).toBe('self_describe')
  expect((await db.doc('deletedAccounts/+15550000001').get()).get('genderIdentity')).toBe('nonbinary')
  expect((await ent(b.uid)).source).toBe('identity') // as Explore now matches them: women
  const again = await planGenderKeys({ db })
  expect(again.writes).toEqual([])
})

// ─── H6 ───────────────────────────────────────────────────────────────────────

// Deletes `who` (as the app does) and signs the same phone up again: a new
// uid with no profile, ready to restore.
async function deleteAndReturn(who) {
  await callAs(who.uid, 'deleteAccount')
  const again = `${who.uid}-back`
  await adminAuth.createUser({ uid: again, phoneNumber: who.phone })
  return again
}
const restore = (uid) => callAs(uid, 'restoreAccount', { birthday: '1995-03-14' })
const blockDoc = async (owner, other) => (await db.doc(`users/${owner}/blockedUsers/${other}`).get()).data() ?? null
// Who `uid`'s deck hides in `mode` (F-105: their own blocks in that mode,
// and everyone who blocked them, in every mode) — blockCore.hiddenInMode.
const hiddenFor = async (uid, mode = 'spark') => {
  const s = (await db.doc(`exploreState/${uid}`).get()).data() ?? {}
  return [...new Set([...(s.blocked ?? []), ...(s[mode]?.blocked ?? [])])]
}

test('H6: delete then restore keeps every block, both ways — the victim\'s on the harasser, and the harasser\'s own', async () => {
  const harry = await seedUser('Harry')
  const vic = await woman('Vic')
  const xan = await woman('Xan')
  await callAs(vic.uid, 'blockUser', { targetUid: harry.uid })
  await callAs(harry.uid, 'blockUser', { targetUid: xan.uid })
  const back = await deleteAndReturn(harry)
  // The attack: the blocks name the old uid, so the new one isn't blocked.
  expect(await blockDoc(vic.uid, harry.uid)).not.toBe(null)
  expect(await blockDoc(vic.uid, back)).toBe(null)
  await restore(back)
  // Re-keyed on both sides, with who placed each.
  expect(await blockDoc(vic.uid, back)).toMatchObject({ uid: back, blockedBy: vic.uid })
  expect(await blockDoc(back, vic.uid)).toMatchObject({ uid: vic.uid, blockedBy: vic.uid })
  expect(await blockDoc(xan.uid, back)).toMatchObject({ uid: back, blockedBy: back })
  expect(await blockDoc(back, xan.uid)).toMatchObject({ uid: xan.uid, blockedBy: back })
  expect(await blockDoc(vic.uid, harry.uid)).toBe(null)
  expect(await blockDoc(xan.uid, harry.uid)).toBe(null)
  // Explore's lists follow.
  expect(await hiddenFor(vic.uid)).toContain(back)
  expect(await hiddenFor(vic.uid)).not.toContain(harry.uid)
  expect(await hiddenFor(back)).toEqual(expect.arrayContaining([vic.uid, xan.uid]))
  expect(await hiddenFor(xan.uid, 'play')).toContain(back) // blocked by him: kept away in every mode
  // In force: neither can act on the other, and he can't lift her block.
  expect(await errOf(callAs(back, 'onTap', { tappedUserId: vic.uid }))).toMatch(/isn't available/)
  expect(await errOf(callAs(vic.uid, 'onTap', { tappedUserId: back }))).toMatch(/isn't available/)
  expect(await errOf(callAs(back, 'unblockUser', { targetUid: vic.uid }))).toMatch(/haven't blocked/)
  // Her list names him under the new uid; his own block is still his to lift.
  expect((await callAs(vic.uid, 'getBlockedUsers')).blocked.map((b) => b.uid)).toEqual([back])
  expect((await callAs(back, 'getBlockedUsers')).blocked.map((b) => b.uid)).toEqual([xan.uid])
})

test('H6: the scam hold (and the trust links) come back with a restored account', async () => {
  const sam = await seedUser('Sam')
  const hold = { at: Timestamp.now(), source: 'scam_reports', reporters: 2 }
  await db.doc(`userInternal/${sam.uid}`).set({ hiddenPendingReview: hold }, { merge: true })
  await db.doc(`trustProfiles/${sam.uid}`).set({ uid: sam.uid, e2e: true })
  await db.doc(`trustFlags/${sam.uid}`).set({ uid: sam.uid, status: 'open', score: 80, reasons: [{ key: 'scam_reports', points: 80, text: 'x' }], openedAt: Timestamp.now(), expiresAt: null })
  await expect.poll(async () => (await db.doc(`exploreIndex/${sam.uid}`).get()).exists, { timeout: 20000 }).toBe(false)
  const back = await deleteAndReturn(sam)
  // Kept through the deletion: the hold in the recovery record, the trust links.
  expect((await db.doc(`deletedAccounts/${sam.phone}`).get()).data().holds.hiddenPendingReview.source).toBe('scam_reports')
  expect((await db.doc(`trustProfiles/${sam.uid}`).get()).exists).toBe(true)
  await restore(back)
  expect((await internalDoc(back)).hiddenPendingReview).toMatchObject({ source: 'scam_reports', reporters: 2 })
  // Still hidden from new people; the admins' flag names the new uid.
  await new Promise((r) => setTimeout(r, 3000))
  await fnLib('explore').refreshEntry(back)
  expect((await db.doc(`exploreIndex/${back}`).get()).exists).toBe(false)
  expect((await db.doc(`trustFlags/${back}`).get()).data()).toMatchObject({ uid: back, status: 'open' })
  expect((await db.doc(`trustFlags/${sam.uid}`).get()).exists).toBe(false)
})

test('H6: no restore while a report waits for review; once reviewed, a suspension or ban on the old uid reaches the restored account', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const hank = await seedUser('Hank')
  const vic = await woman('Vic')
  await likeAs(hank.uid, vic.uid)
  expect((await likeAs(vic.uid, hank.uid)).matched).toBe(true)
  await callAs(vic.uid, 'submitReport', { matchId: sortedPair(hank.uid, vic.uid), reportedUid: hank.uid, categories: ['aggressive'] })
  const back = await deleteAndReturn(hank)
  // The attack: delete and restore to leave the report on a uid nobody uses.
  expect(await errOf(restore(back))).toMatch(/can't be restored right now/)
  expect((await db.doc(`users/${back}`).get()).exists).toBe(false)
  expect((await db.doc(`deletedAccounts/${hank.phone}`).get()).exists).toBe(true)
  // Reviewed (no action): the restore goes through.
  await callAs(admin.uid, 'adminModerate', { uid: hank.uid, action: 'clear' })
  expect((await restore(back)).success).toBe(true)
  // A later report decision on the old uid: the suspension lands on the new one.
  await callAs(admin.uid, 'adminModerate', { uid: hank.uid, action: 'suspend', days: 30 })
  expect((await internalDoc(back)).isSuspended).toBe(true)
  const audit = (await db.collection('adminAudit').where('action', '==', 'report.suspend').get()).docs.map((d) => d.data())
  expect(audit[0]).toMatchObject({ target: back })
  // …and a ban: the phone, the soft delete and the recovery record marked.
  await callAs(admin.uid, 'adminModerate', { uid: hank.uid, action: 'ban' })
  expect((await userDoc(back)).isDeleted).toBe(true)
  expect((await db.doc(`bannedPhones/${phoneKey(hank.phone)}`).get()).data()).toMatchObject({ uid: back, banned: true })
  expect((await db.doc(`deletedAccounts/${hank.phone}`).get()).data()).toMatchObject({ banned: true, previousUid: back })
})
