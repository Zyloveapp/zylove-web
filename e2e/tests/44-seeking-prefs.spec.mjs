// Body-type, trait and height preferences have one home: the owner-only
// users/{uid}/private/matching, which scoring reads. The web editor used to
// save them to seekingPreferences/prefs, where scoring never looked, so a web
// user's physical preferences never took effect (as with the dealbreakers,
// spec 39). Now the editor saves them to private/matching (plain owner
// writes, no rate limit), the rules refuse them in seekingPreferences, the
// app shows an old seekingPreferences value until migrated, and the migration
// (scripts/lib/seekingPrefs.mjs) moves the old values.
import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, callAs, idTokenFor, setPlan, db, sortedPair, PROJECT, PHOTO, FieldValue,
} from './helpers.mjs'
import { applySeekingPrefs, planSeekingPrefs, summarySeekingPrefs } from '../../scripts/lib/seekingPrefs.mjs'

test.beforeEach(resetEmulators)

const DOCS = `projects/${PROJECT}/databases/(default)/documents`
const matchingOf = async (uid) => (await db.doc(`users/${uid}/private/matching`).get()).data() ?? {}
const prefsOf = async (uid) => (await db.doc(`users/${uid}/seekingPreferences/prefs`).get()).data()
const MOVED = ['seekingBodyTypes', 'seekingTraits', 'seekingHeightMinCm', 'seekingHeightMaxCm']
const woman = (name, o = {}) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o })

// A client write (REST, the owner's ID token): a full set, or with `mask`
// only those fields (a merge).
const val = (v) =>
  Array.isArray(v) ? { arrayValue: { values: v.map(val) } } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v }
async function writeAsOwner(uid, path, data, mask = null) {
  const update = { name: `${DOCS}/${path}`, fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, val(v)])) }
  const r = await fetch(`http://127.0.0.1:8390/v1/${DOCS}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [{ update, ...(mask && { updateMask: { fieldPaths: mask } }) }] }),
  })
  return r.status
}

// ─── Rules ───────────────────────────────────────────────────────────────────

test('rules: seekingPreferences refuses body types, traits and the height range; private/matching takes them from the owner', async () => {
  const u = await seedUser('Rae')
  const path = `users/${u.uid}/seekingPreferences/prefs`
  const flags = { uid: u.uid, seekingBodyNoPreference: false, seekingHeightNoPreference: true }
  for (const extra of [{ seekingBodyTypes: ['slim'] }, { seekingBodyTypes: [] }, { seekingTraits: ['kind'] }, { seekingHeightMinCm: 160 }, { seekingHeightMaxCm: 190 }]) {
    expect(await writeAsOwner(u.uid, path, { ...flags, ...extra }), Object.keys(extra)[0]).toBe(403)
  }
  expect(await writeAsOwner(u.uid, path, flags)).toBe(200)
  // Mobile's own seekingPreferences fields still save.
  expect(await writeAsOwner(u.uid, path, { uid: u.uid, smokingDealbreaker: 'no_preference', heightPreference: 'taller' })).toBe(200)
  // An old doc with values (before the migration): a set without them goes
  // through and replaces them; a merge that keeps them doesn't.
  await db.doc(path).set({ seekingTraits: ['kind'] }, { merge: true })
  expect(await writeAsOwner(u.uid, path, { _lastUpdated: 1 }, ['_lastUpdated'])).toBe(403)
  expect(await writeAsOwner(u.uid, path, flags)).toBe(200)
  expect(await prefsOf(u.uid)).toEqual(flags)

  // private/matching: the owner's, no 30-day limit (two changes in a row).
  const m = `users/${u.uid}/private/matching`
  const prefs = { seekingBodyTypes: ['athletic'], seekingTraits: ['kind', 'funny'], seekingHeightMinCm: 170, seekingHeightMaxCm: 190 }
  expect(await writeAsOwner(u.uid, m, prefs, Object.keys(prefs))).toBe(200)
  expect(await writeAsOwner(u.uid, m, { ...prefs, seekingBodyTypes: ['slim'], seekingHeightMinCm: 160 }, Object.keys(prefs))).toBe(200)
  expect(await matchingOf(u.uid)).toMatchObject({ ...prefs, seekingBodyTypes: ['slim'], seekingHeightMinCm: 160 })
  expect((await matchingOf(u.uid)).fieldChangedAt?.seekingBodyTypes).toBeUndefined()
  // Lists of keys and numbers only.
  expect(await writeAsOwner(u.uid, m, { seekingBodyTypes: 'slim' }, ['seekingBodyTypes'])).toBe(403)
  expect(await writeAsOwner(u.uid, m, { seekingHeightMinCm: '160' }, ['seekingHeightMinCm'])).toBe(403)
  // Someone else's: no.
  const other = await seedUser('Sam')
  expect(await writeAsOwner(other.uid, m, prefs, Object.keys(prefs))).toBe(403)
  expect(await writeAsOwner(other.uid, path, flags)).toBe(403)
})

// ─── The app ─────────────────────────────────────────────────────────────────

async function open(browser, user) {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, user.uid)
  await page.addInitScript((u) => sessionStorage.setItem(`zylove_profile_question_${u}`, '{}'), user.uid)
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page, net }
}
// "Reimagine my profile" at a step (index in the refresh flow), with `draft`
// over the saved profile (specs 38 and 39 do the same).
const STEPS = { physical: 15, needs: 16, review: 24 }
const today = new Date()
const AGE = today.getFullYear() - 1995 - (today.getMonth() < 2 || (today.getMonth() === 2 && today.getDate() < 14) ? 1 : 0)
const draftKey = (uid) => `zylove_onboarding_draft_refresh_${uid}`
async function refreshAt(page, uid, step, draft = {}) {
  const d = { photos: [{ id: 'p0', file: null, previewUrl: PHOTO }], ...draft }
  await page.evaluate(([k, i, d]) => localStorage.setItem(k, JSON.stringify({ v: 1, savedAt: Date.now(), stepIndex: i, data: { draft: d } })), [draftKey(uid), STEPS[step], d])
  await page.goto('/onboarding?refresh=true')
}
// The draft as edited so far, then on to another step.
async function jumpTo(page, uid, step) {
  await page.evaluate(([k, i]) => {
    const s = JSON.parse(localStorage.getItem(k))
    localStorage.setItem(k, JSON.stringify({ ...s, stepIndex: i }))
  }, [draftKey(uid), STEPS[step]])
  await page.goto('/onboarding?refresh=true')
}
const savedDraft = (page, uid) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}').data?.draft ?? {}, draftKey(uid))
async function save(page) {
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.waitForURL(/\/profile/, { timeout: 60000 })
}
// Bea's own physical bar for Abe (F-098: stored per uid), as scored.
const physicalFor = async (a, b, uid) => (await db.doc(`pairs/${sortedPair(a, b)}/modes/spark`).get()).data()?.sparkBreakdown?.physicalPrefsFor?.[uid]

test('app: body types, height and traits picked in the editor save to private/matching and move the viewer\'s physical bar; "Doesn\'t matter" clears them', async ({ browser }) => {
  // Abe is 6'2" and athletic; Bea has no physical preferences yet.
  const a = await seedUser('Abe', { heightCm: 188, bodyType: 'athletic' })
  const b = await woman('Bea', { age: AGE, heightCm: 165, bodyType: 'curvy' })
  await setPlan(b.uid, 'spark_plus')
  const before = await callAs(b.uid, 'onTap', { tappedUserId: a.uid })
  expect(before.breakdown.spark.physicalPrefs).toBeNull()

  const { ctx, page, net } = await open(browser, b)
  await refreshAt(page, b.uid, 'physical')
  await expect(page.getByRole('heading', { name: 'Physical preferences' })).toBeVisible({ timeout: 20000 })
  await page.getByLabel("Doesn't matter to me").uncheck()
  await page.getByLabel('Minimum height feet').selectOption('6')
  await page.getByLabel('Minimum height inches').selectOption('0')
  await page.getByLabel('Maximum height feet').selectOption('6')
  await page.getByLabel('Maximum height inches').selectOption('8')
  await page.getByRole('button', { name: '⚡ Athletic' }).click()
  await page.getByRole('button', { name: '💪 Muscular' }).click()
  await expect.poll(async () => (await savedDraft(page, b.uid)).seekingBodyTypes).toEqual(['athletic', 'muscular'])
  await jumpTo(page, b.uid, 'needs')
  await expect(page.getByRole('heading', { name: 'What do you need?' })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'Kind', exact: true }).click()
  await page.getByRole('button', { name: 'Funny', exact: true }).click()
  await expect.poll(async () => (await savedDraft(page, b.uid)).seekingTraits).toEqual(['kind', 'funny'])
  await jumpTo(page, b.uid, 'review')
  await save(page)

  // private/matching (heights in cm, as scoring compares them); not seekingPreferences.
  expect(await matchingOf(b.uid)).toMatchObject({
    seekingBodyTypes: ['athletic', 'muscular'], seekingTraits: ['kind', 'funny'], seekingHeightMinCm: 183, seekingHeightMaxCm: 203,
  })
  expect((await matchingOf(b.uid)).fieldChangedAt ?? {}).toEqual({})
  const prefs = await prefsOf(b.uid)
  for (const k of MOVED) expect(prefs[k], k).toBeUndefined()
  expect(prefs).toMatchObject({ seekingHeightNoPreference: false, seekingBodyNoPreference: false })
  // They take effect: the pair re-scores; Bea's own bar is now 100 (Abe is
  // in range and athletic), and her tap shows it.
  await expect.poll(() => physicalFor(a.uid, b.uid, b.uid), { timeout: 30000 }).toBe(100)
  expect((await callAs(b.uid, 'onTap', { tappedUserId: a.uid })).breakdown.spark.physicalPrefs).toBe(100)
  // Abe's own direction is untouched (he stated nothing).
  expect(await physicalFor(a.uid, b.uid, a.uid)).toBeNull()
  // The profile lists the traits.
  await expect(page.getByText('Looking for', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('Funny', { exact: true })).toBeVisible()

  // The editor reopens with them; "Doesn't matter" on both clears them.
  await refreshAt(page, b.uid, 'physical')
  await expect(page.getByRole('heading', { name: 'Physical preferences' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByLabel("Doesn't matter to me")).not.toBeChecked()
  await expect(page.getByLabel('Maximum height inches')).toHaveValue('8')
  await expect(page.getByRole('button', { name: '⚡ Athletic' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByLabel("Doesn't matter to me").check()
  await page.getByRole('button', { name: "Doesn't matter", exact: true }).click()
  await expect.poll(async () => (await savedDraft(page, b.uid)).seekingBodyNoPreference).toBe(true)
  await jumpTo(page, b.uid, 'review')
  await save(page)
  const m = await matchingOf(b.uid)
  expect(m.seekingBodyTypes).toEqual([])
  expect(m.seekingHeightMinCm).toBeUndefined()
  expect(m.seekingHeightMaxCm).toBeUndefined()
  expect(m.seekingTraits).toEqual(['kind', 'funny'])
  await expect.poll(() => physicalFor(a.uid, b.uid, b.uid), { timeout: 30000 }).toBeNull()
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('app: old seekingPreferences values show until migrated, and the next save moves them to private/matching', async ({ browser }) => {
  const u = await seedUser('Dee', { age: AGE })
  await db.doc(`users/${u.uid}/seekingPreferences/prefs`).set({
    uid: u.uid, seekingTraits: ['honest'], seekingBodyTypes: ['slim'], seekingHeightMinCm: 160, seekingHeightMaxCm: 180, seekingHeightNoPreference: false,
  })
  const { ctx, page, net } = await open(browser, u)
  await page.goto('/profile')
  await expect(page.getByText('Looking for', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('Honest', { exact: true })).toBeVisible()
  // The editor shows them: 160–180 cm is 5'3"–5'11".
  await refreshAt(page, u.uid, 'physical')
  await expect(page.getByRole('heading', { name: 'Physical preferences' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByLabel("Doesn't matter to me")).not.toBeChecked()
  await expect(page.getByLabel('Minimum height feet')).toHaveValue('5')
  await expect(page.getByLabel('Minimum height inches')).toHaveValue('3')
  await expect(page.getByLabel('Maximum height inches')).toHaveValue('11')
  await expect(page.getByRole('button', { name: '🌿 Slim' })).toHaveAttribute('aria-pressed', 'true')
  await jumpTo(page, u.uid, 'review')
  await save(page)
  expect(await matchingOf(u.uid)).toMatchObject({ seekingTraits: ['honest'], seekingBodyTypes: ['slim'], seekingHeightMinCm: 160, seekingHeightMaxCm: 180 })
  const prefs = await prefsOf(u.uid)
  for (const k of MOVED) expect(prefs[k], k).toBeUndefined()
  expect(net.errors).toEqual([])
  await ctx.close()
})

// ─── The migration ───────────────────────────────────────────────────────────

test('migration: per field — copies where private/matching has none, keeps a different value (conflict), drops invalid ones, removes the fields; idempotent', async () => {
  const copy = await seedUser('Ann')
  const conflict = await seedUser('Ben', { seekingBodyTypes: ['curvy'] })
  const same = await seedUser('Cat', { seekingTraits: ['kind', 'funny'] })
  const invalid = await seedUser('Dan')
  const noPref = await seedUser('Eve')
  const deleted = await seedUser('Fox', { isDeleted: true })
  const untouched = await seedUser('Gil')
  const mobile = await seedUser('Hal')
  const prefs = (u, data) => db.doc(`users/${u.uid}/seekingPreferences/prefs`).set({ uid: u.uid, ...data })
  await prefs(copy, { seekingBodyTypes: ['athletic', 'slim', 'tall'], seekingTraits: ['kind', 'kind'], seekingHeightMinCm: 170, seekingHeightMaxCm: 190, seekingHeightNoPreference: false })
  await prefs(conflict, { seekingBodyTypes: ['slim'], seekingTraits: ['funny'] })
  await prefs(same, { seekingTraits: ['funny', 'kind'] })
  await prefs(invalid, { seekingHeightMinCm: 190, seekingHeightMaxCm: 170, seekingTraits: ['nice'] })
  await prefs(noPref, { seekingHeightMinCm: 160, seekingHeightMaxCm: 180, seekingHeightNoPreference: true })
  await prefs(deleted, { seekingTraits: ['kind'] })
  await prefs(untouched, { seekingHeightNoPreference: true, seekingBodyNoPreference: true })
  await prefs(mobile, { smokingDealbreaker: 'no_preference', heightPreference: 'taller', seekingTraits: ['honest'] }) // legacy mobile fields stay

  const plan = await planSeekingPrefs({ db })
  expect(summarySeekingPrefs(plan)).toEqual({
    'accounts with seekingPreferences body types, traits or height': 7,
    'body types: accounts with one': 2,
    'body types: copied to private/matching': 1,
    'body types: identical already (nothing to copy)': 0,
    'body types: conflicts: a different value in effect (private kept)': 1,
    'body types: empty or no preference (nothing to copy)': 0,
    'body types: deleted or missing accounts (nothing copied)': 0,
    'body types: invalid values dropped': 1,
    'traits: accounts with one': 6,
    'traits: copied to private/matching': 3,
    'traits: identical already (nothing to copy)': 1,
    'traits: conflicts: a different value in effect (private kept)': 0,
    'traits: empty or no preference (nothing to copy)': 1,
    'traits: deleted or missing accounts (nothing copied)': 1,
    'traits: invalid values dropped': 1,
    'height range: accounts with one': 3,
    'height range: copied to private/matching': 1,
    'height range: identical already (nothing to copy)': 0,
    'height range: conflicts: a different value in effect (private kept)': 0,
    'height range: empty or no preference (nothing to copy)': 2,
    'height range: deleted or missing accounts (nothing copied)': 0,
    'height range: invalid values dropped': 1,
    'seekingPreferences docs losing fields': 7,
    'docs backed up before any write': 10, // seven prefs docs + the three private/matching docs copied into
  })
  expect(Object.keys(plan.backup)).toEqual(expect.arrayContaining([`users/${copy.uid}/private/matching`, `users/${conflict.uid}/seekingPreferences/prefs`]))
  expect(plan.backup[`users/${untouched.uid}/seekingPreferences/prefs`]).toBeUndefined()
  expect(plan.backup[`users/${same.uid}/private/matching`]).toBeUndefined()
  await applySeekingPrefs({ db, FieldValue }, plan)

  expect(await matchingOf(copy.uid)).toMatchObject({ seekingBodyTypes: ['athletic', 'slim'], seekingTraits: ['kind'], seekingHeightMinCm: 170, seekingHeightMaxCm: 190 })
  expect(await matchingOf(conflict.uid)).toMatchObject({ seekingBodyTypes: ['curvy'], seekingTraits: ['funny'] })
  expect((await matchingOf(same.uid)).seekingTraits).toEqual(['kind', 'funny'])
  const inv = await matchingOf(invalid.uid)
  expect([inv.seekingTraits, inv.seekingHeightMinCm, inv.seekingHeightMaxCm]).toEqual([undefined, undefined, undefined])
  expect((await matchingOf(noPref.uid)).seekingHeightMinCm).toBeUndefined()
  expect((await matchingOf(deleted.uid)).seekingTraits).toBeUndefined()
  expect((await matchingOf(mobile.uid)).seekingTraits).toEqual(['honest'])
  for (const u of [copy, conflict, same, invalid, noPref, deleted, untouched, mobile]) {
    const p = await prefsOf(u.uid)
    for (const k of MOVED) expect(p[k], `${u.name} ${k}`).toBeUndefined()
    expect(p.uid, u.name).toBe(u.uid)
  }
  expect(await prefsOf(noPref.uid)).toEqual({ uid: noPref.uid, seekingHeightNoPreference: true })
  expect(await prefsOf(mobile.uid)).toEqual({ uid: mobile.uid, smokingDealbreaker: 'no_preference', heightPreference: 'taller' })
  // A second run finds nothing.
  const again = await planSeekingPrefs({ db })
  for (const [k, n] of Object.entries(summarySeekingPrefs(again))) expect(n, k).toBe(0)
  expect(await applySeekingPrefs({ db, FieldValue }, again)).toBe(0)
})
