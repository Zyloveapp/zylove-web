// Dealbreakers have one home: the owner-only users/{uid}/private/matching,
// which scoring reads. The web editor used to save them to
// seekingPreferences/prefs, where scoring never looked, so they never took
// effect. Now the editor saves them to private/matching under the F-099
// 30-day limit (first value free, later changes stamped), the rules refuse
// them in seekingPreferences, and the migration (scripts/lib/dealbreakers.mjs)
// moves the old lists. Also ensureSortKey no longer re-creates a deleted
// user doc.
import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, callAs, idTokenFor, db, sortedPair, PROJECT, PHOTO, Timestamp, FieldValue,
} from './helpers.mjs'
import { applyDealbreakers, planDealbreakers, summaryDealbreakers } from '../../scripts/lib/dealbreakers.mjs'

test.beforeEach(resetEmulators)

const DAY = 24 * 60 * 60 * 1000
const DOCS = `projects/${PROJECT}/databases/(default)/documents`
const matchingOf = async (uid) => (await db.doc(`users/${uid}/private/matching`).get()).data() ?? {}
const prefsOf = async (uid) => (await db.doc(`users/${uid}/seekingPreferences/prefs`).get()).data()
const stampAgo = (uid, daysAgo) =>
  db.doc(`users/${uid}/private/matching`).set({ fieldChangedAt: { dealbreakers: Timestamp.fromMillis(Date.now() - daysAgo * DAY) } }, { merge: true })
const dateOf = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

// A client write (REST, the owner's ID token): no updateMask = a full set.
const val = (v) =>
  Array.isArray(v) ? { arrayValue: { values: v.map(val) } } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v }
async function setAsOwner(uid, path, data) {
  const r = await fetch(`http://127.0.0.1:8390/v1/${DOCS}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [{ update: { name: `${DOCS}/${path}`, fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, val(v)])) } }] }),
  })
  return r.status
}

// ─── Rules ───────────────────────────────────────────────────────────────────

test('rules: seekingPreferences refuses dealbreakers; its other fields still save, and a set without them replaces an old list', async () => {
  const u = await seedUser('Rae')
  const path = `users/${u.uid}/seekingPreferences/prefs`
  const prefs = { uid: u.uid, seekingTraits: ['kind'], seekingBodyTypes: [], seekingHeightNoPreference: true }
  expect(await setAsOwner(u.uid, path, { ...prefs, dealbreakers: ['vaper'] })).toBe(403)
  expect(await setAsOwner(u.uid, path, { ...prefs, dealbreakers: [] })).toBe(403)
  expect(await setAsOwner(u.uid, path, prefs)).toBe(200)
  // An old doc with a list (before the migration): a save without one goes through.
  await db.doc(path).set({ dealbreakers: ['vaper'] }, { merge: true })
  expect(await setAsOwner(u.uid, path, { ...prefs, seekingTraits: ['funny'] })).toBe(200)
  expect(await prefsOf(u.uid)).toEqual({ ...prefs, seekingTraits: ['funny'] })
  // Someone else's: no.
  const other = await seedUser('Sam')
  expect(await setAsOwner(other.uid, path, prefs)).toBe(403)
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
// over the saved profile (spec 38 does the same).
const STEPS = { needs: 16, review: 24 }
const today = new Date()
const AGE = today.getFullYear() - 1995 - (today.getMonth() < 2 || (today.getMonth() === 2 && today.getDate() < 14) ? 1 : 0)
const draftKey = (uid) => `zylove_onboarding_draft_refresh_${uid}`
async function refreshAt(page, uid, step, draft = {}) {
  const d = { photos: [{ id: 'p0', file: null, previewUrl: PHOTO }], ...draft }
  await page.evaluate(([k, i, d]) => localStorage.setItem(k, JSON.stringify({ v: 1, savedAt: Date.now(), stepIndex: i, data: { draft: d } })), [draftKey(uid), STEPS[step], d])
  await page.goto('/onboarding?refresh=true')
}
async function save(page) {
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.waitForURL(/\/profile/, { timeout: 60000 })
}
const sparkDetails = async (a, b) => (await db.doc(`pairs/${sortedPair(a, b)}/modes/spark`).get()).data() ?? {}
const sparkScore = async (a, b) => (await db.doc(`pairs/${sortedPair(a, b)}`).get()).data()?.sparkScore

test('app: dealbreakers picked in the editor save to private/matching (first value free, sorted) and cap the score; then the 30-day lock', async ({ browser }) => {
  // Adam drinks regularly; Bella has no dealbreakers yet.
  const a = await seedUser('Adam', { drinkingHabit: 'regularly' })
  const b = await seedUser('Bella', { age: AGE, genderIdentity: 'woman', attractedTo: ['men'] })
  await callAs(a.uid, 'onTap', { tappedUserId: b.uid })
  expect((await sparkDetails(a.uid, b.uid)).triggeredDealbreakers).toEqual([])
  const before = await sparkScore(a.uid, b.uid)
  expect(typeof before).toBe('number')

  const { ctx, page, net } = await open(browser, b)
  // The editor: pick two on "What do you need?", then save from the review.
  await refreshAt(page, b.uid, 'needs')
  await expect(page.getByRole('heading', { name: 'What do you need?' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByTestId('field-locked')).toHaveCount(0)
  await page.getByRole('button', { name: 'Vaper' }).click()
  await page.getByRole('button', { name: 'Heavy drinker' }).click()
  await expect(page.getByRole('button', { name: 'Heavy drinker' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}').data?.draft?.dealbreakers, draftKey(b.uid))).toEqual(['vaper', 'heavy_drinker'])
  await page.evaluate(([k, i]) => {
    const s = JSON.parse(localStorage.getItem(k))
    localStorage.setItem(k, JSON.stringify({ ...s, stepIndex: i }))
  }, [draftKey(b.uid), STEPS.review])
  await page.goto('/onboarding?refresh=true')
  await save(page)

  // private/matching, sorted, no stamp (a first value); nothing in seekingPreferences.
  const m = await matchingOf(b.uid)
  expect(m.dealbreakers).toEqual(['heavy_drinker', 'vaper'])
  expect(m.fieldChangedAt?.dealbreakers).toBeUndefined()
  expect((await prefsOf(b.uid)).dealbreakers).toBeUndefined()
  // It takes effect: the pair re-scores with Bella's dealbreaker, capped.
  await expect.poll(async () => (await sparkDetails(a.uid, b.uid)).triggeredDealbreakers, { timeout: 30000 }).toEqual(['heavy_drinker'])
  expect(await sparkScore(a.uid, b.uid)).toBeLessThanOrEqual(35)
  // The profile lists them.
  await expect(page.getByText('🚫 Heavy drinker')).toBeVisible({ timeout: 20000 })

  // A change counts (stamped)…
  await refreshAt(page, b.uid, 'review', { dealbreakers: ['heavy_drinker'] })
  await save(page)
  expect((await matchingOf(b.uid)).dealbreakers).toEqual(['heavy_drinker'])
  expect((await matchingOf(b.uid)).fieldChangedAt.dealbreakers).toBeInstanceOf(Timestamp)
  // …and then they're locked: read-only, with the date.
  await refreshAt(page, b.uid, 'needs', { dealbreakers: ['vaper'] })
  await expect(page.getByRole('heading', { name: 'What do you need?' })).toBeVisible({ timeout: 20000 })
  const stamp = (await matchingOf(b.uid)).fieldChangedAt.dealbreakers.toMillis()
  await expect(page.getByTestId('field-locked')).toHaveText(`You can change this again on ${dateOf(stamp + 30 * DAY)}.`)
  await expect(page.getByRole('button', { name: 'Heavy drinker' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Vaper' })).toBeDisabled()
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('app: a save refused because the dealbreakers locked meanwhile names them and the date', async ({ browser }) => {
  const u = await seedUser('Cleo', { age: AGE, dealbreakers: ['vaper'] })
  await stampAgo(u.uid, 31)
  const { ctx, page, net } = await open(browser, u)
  await refreshAt(page, u.uid, 'review', { dealbreakers: ['cigarette_smoker'] })
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(1500) // the page has read the (unlocked) field
  await stampAgo(u.uid, 0) // changed on another device
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText(`You can change your dealbreakers again on ${dateOf(Date.now() + 30 * DAY)}.`)).toBeVisible({ timeout: 20000 })
  await expect(page.getByText(/Something went wrong|session needs refreshing/)).toHaveCount(0)
  expect((await matchingOf(u.uid)).dealbreakers).toEqual(['vaper'])
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('app: an old seekingPreferences list shows until migrated, and the next save moves it to private/matching (first value)', async ({ browser }) => {
  const u = await seedUser('Dee', { age: AGE })
  await db.doc(`users/${u.uid}/seekingPreferences/prefs`).set({ uid: u.uid, seekingTraits: ['kind'], dealbreakers: ['vaper'], seekingHeightNoPreference: true })
  const { ctx, page, net } = await open(browser, u)
  await page.goto('/profile')
  await expect(page.getByText('🚫 Vaper')).toBeVisible({ timeout: 20000 })
  await refreshAt(page, u.uid, 'review')
  await save(page)
  const m = await matchingOf(u.uid)
  expect(m.dealbreakers).toEqual(['vaper'])
  expect(m.fieldChangedAt?.dealbreakers).toBeUndefined()
  const prefs = await prefsOf(u.uid)
  expect(prefs.dealbreakers).toBeUndefined()
  expect(prefs.seekingTraits).toEqual(['kind'])
  expect(net.errors).toEqual([])
  await ctx.close()
})

// ─── The migration ───────────────────────────────────────────────────────────

test('migration: copies into an empty private list (no stamp), keeps a different one (conflict), removes the field everywhere; idempotent', async () => {
  const copy = await seedUser('Ann')
  const conflict = await seedUser('Ben', { dealbreakers: ['cigarette_smoker'] })
  const same = await seedUser('Cat', { dealbreakers: ['heavy_drinker', 'vaper'] })
  const empty = await seedUser('Dan')
  const cleared = await seedUser('Eve', { dealbreakers: [] })
  const deleted = await seedUser('Fox', { isDeleted: true })
  const untouched = await seedUser('Gil')
  const prefs = (u, extra) => db.doc(`users/${u.uid}/seekingPreferences/prefs`).set({ uid: u.uid, seekingTraits: ['kind'], ...extra })
  await prefs(copy, { dealbreakers: ['vaper', 'heavy_drinker', 'smoker', 'vaper'] }) // 'smoker': the retired enum
  await prefs(conflict, { dealbreakers: ['vaper'] })
  await prefs(same, { dealbreakers: ['vaper', 'heavy_drinker'] })
  await prefs(empty, { dealbreakers: [] })
  await prefs(cleared, { dealbreakers: ['vaper'] })
  await stampAgo(cleared.uid, 3) // cleared under the 30-day limit
  await prefs(deleted, { dealbreakers: ['vaper'] })
  await prefs(untouched, {})

  const plan = await planDealbreakers({ db })
  const s = summaryDealbreakers(plan)
  expect(s).toEqual({
    'accounts with seekingPreferences dealbreakers': 6,
    'copied to private/matching (first value, no stamp)': 1,
    'identical already (nothing to copy)': 1,
    'conflicts: a different list in effect (private value kept)': 1,
    'conflicts: cleared under the 30-day limit (kept)': 1,
    'empty lists skipped (nothing valid to copy)': 1,
    'deleted or missing accounts (nothing copied)': 1,
    'invalid values dropped (not scoring keys)': 1,
    'seekingPreferences docs losing the field': 6,
    'docs backed up before any write': 7, // six prefs docs + the private/matching copied into
  })
  expect(Object.keys(plan.backup)).toEqual(expect.arrayContaining([`users/${copy.uid}/private/matching`, `users/${conflict.uid}/seekingPreferences/prefs`]))
  expect(plan.backup[`users/${untouched.uid}/seekingPreferences/prefs`]).toBeUndefined()
  await applyDealbreakers({ db, FieldValue }, plan)

  const mc = await matchingOf(copy.uid)
  expect(mc.dealbreakers).toEqual(['heavy_drinker', 'vaper'])
  expect(mc.fieldChangedAt?.dealbreakers).toBeUndefined()
  expect((await matchingOf(conflict.uid)).dealbreakers).toEqual(['cigarette_smoker'])
  expect((await matchingOf(same.uid)).dealbreakers).toEqual(['heavy_drinker', 'vaper'])
  expect((await matchingOf(cleared.uid)).dealbreakers).toEqual([])
  expect((await matchingOf(deleted.uid)).dealbreakers).toBeUndefined()
  for (const u of [copy, conflict, same, empty, cleared, deleted, untouched]) {
    const p = await prefsOf(u.uid)
    expect(p.dealbreakers, u.name).toBeUndefined()
    expect(p.seekingTraits, u.name).toEqual(['kind'])
  }
  // A second run finds nothing.
  const again = await planDealbreakers({ db })
  for (const [k, n] of Object.entries(summaryDealbreakers(again))) expect(n, k).toBe(0)
  expect(await applyDealbreakers({ db, FieldValue }, again)).toBe(0)
})

// ─── ensureSortKey ───────────────────────────────────────────────────────────

test('ensureSortKey: a new user doc gets a sortKey; one deleted right after it was written stays deleted', async () => {
  const live = 'e2e-sortkey-live'
  await db.doc(`users/${live}`).set({ uid: live, displayName: 'Live' })
  await expect.poll(async () => typeof (await db.doc(`users/${live}`).get()).data()?.sortKey, { timeout: 20000 }).toBe('number')

  const gone = 'e2e-sortkey-gone'
  await db.doc(`users/${gone}`).set({ uid: gone, displayName: 'Gone' })
  await db.doc(`users/${gone}`).delete()
  // Past the trigger (the live doc above shows how long it takes).
  await new Promise((r) => setTimeout(r, 8000))
  expect((await db.doc(`users/${gone}`).get()).exists).toBe(false)
})
