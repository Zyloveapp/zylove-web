// F-099 (2026-10-09): religion, politics, drinking, attraction and
// dealbreakers (owner-only private/matching) and the intent (private/profile)
// change at most once every 30 days each — dealbreaker probing (your own
// different_religion / heavy_drinker dealbreaker, then cycling your own value)
// re-scored every pair on every edit. The first value is free; a change
// stamps fieldChangedAt.<field> with the request time; clearing counts;
// saving the same value doesn't. Rules through the REST API with the owner's
// ID token (server transforms for the stamps), then the app.
import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, idTokenFor, db, PROJECT, Timestamp, FieldValue } from './helpers.mjs'

test.beforeEach(resetEmulators)

const DAY = 24 * 60 * 60 * 1000
const DOCS = `projects/${PROJECT}/databases/(default)/documents`
const MATCHING = ['religion', 'politicalView', 'drinkingHabit', 'attractedTo', 'dealbreakers']
// Three values per field: first, second, third.
const VALUES = {
  religion: ['christian', 'jewish', 'buddhist'],
  politicalView: ['independent', 'democrat', 'republican'],
  drinkingHabit: ['never', 'socially', 'regularly'],
  attractedTo: [['women'], ['men'], ['everyone']],
  dealbreakers: [['vaper'], ['heavy_drinker'], ['cigarette_smoker', 'vaper']],
  intent: ['spark', 'play', 'open'],
}
const docOf = (f) => (f === 'intent' ? 'profile' : 'matching')

// A REST value from a plain one (Date → timestamp; nested objects → maps).
function val(v) {
  if (v === null) return { nullValue: null }
  if (v instanceof Date) return { timestampValue: v.toISOString() }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(val) } }
  if (typeof v === 'number') return { integerValue: String(v) }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)])) } }
  return { stringValue: v }
}
// One write as a client: `set` (top-level fields, or 'a.b' paths), `del`
// (field paths removed), `stamp` (fields whose fieldChangedAt.<f> becomes the
// request time — serverTimestamp()).
function update(path, { set = {}, del = [], stamp = [] } = {}) {
  const fields = {}
  for (const [k, v] of Object.entries(set)) {
    const [top, sub] = k.split('.')
    if (sub) fields[top] = { mapValue: { fields: { ...(fields[top]?.mapValue.fields ?? {}), [sub]: val(v) } } }
    else fields[top] = val(v)
  }
  return {
    update: { name: `${DOCS}/${path}`, fields },
    updateMask: { fieldPaths: [...Object.keys(set), ...del] },
    updateTransforms: stamp.map((f) => ({ fieldPath: `fieldChangedAt.${f}`, setToServerValue: 'REQUEST_TIME' })),
  }
}
async function commit(uid, writes) {
  const r = await fetch(`http://127.0.0.1:8390/v1/${DOCS}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
  })
  return r.status
}
const write = (uid, doc, opts) => commit(uid, [update(`users/${uid}/private/${doc}`, opts)])
const data = async (uid, doc) => (await db.doc(`users/${uid}/private/${doc}`).get()).data() ?? {}
const stampOf = async (uid, f) => (await data(uid, docOf(f))).fieldChangedAt?.[f]
// Admin: stamps as if each field last changed `daysAgo` days ago.
async function stampAgo(uid, fields, daysAgo) {
  for (const f of fields) {
    await db.doc(`users/${uid}/private/${docOf(f)}`).set({ fieldChangedAt: { [f]: Timestamp.fromMillis(Date.now() - daysAgo * DAY) } }, { merge: true })
  }
}
// A seeded member with none of the six set (as before onboarding asks).
async function blank(name) {
  const u = await seedUser(name)
  await db.doc(`users/${u.uid}/private/matching`).update(Object.fromEntries(MATCHING.map((f) => [f, FieldValue.delete()])))
  await db.doc(`users/${u.uid}/private/profile`).update({ intent: FieldValue.delete() })
  return u
}
const dateOf = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

test('F-099: the first value is free; then one change (stamped), and a second within 30 days is refused — each of the six', async () => {
  const u = await blank('Fay')
  for (const [f, [a, b, c]] of Object.entries(VALUES)) {
    const doc = docOf(f)
    // First value: no stamp needed, and no clock starts.
    expect(await write(u.uid, doc, { set: { [f]: a } }), `${f} first`).toBe(200)
    expect(await stampOf(u.uid, f), `${f} no stamp`).toBeUndefined()
    // A change must stamp…
    expect(await write(u.uid, doc, { set: { [f]: b } }), `${f} unstamped change`).toBe(403)
    expect(await write(u.uid, doc, { set: { [f]: b }, stamp: [f] }), `${f} change`).toBe(200)
    expect((await data(u.uid, doc))[f]).toEqual(b)
    expect(await stampOf(u.uid, f), `${f} stamped`).toBeInstanceOf(Timestamp)
    // …the same value again isn't a change…
    expect(await write(u.uid, doc, { set: { [f]: b } }), `${f} same value`).toBe(200)
    // …and a second change within 30 days is refused, stamped or not.
    expect(await write(u.uid, doc, { set: { [f]: c }, stamp: [f] }), `${f} second change`).toBe(403)
    expect(await write(u.uid, doc, { set: { [f]: c } }), `${f} second change, unstamped`).toBe(403)
    expect((await data(u.uid, doc))[f]).toEqual(b)
  }
})

test('F-099: a value set before the limit (existing accounts) changes once, then locks; after 30 days it changes again', async () => {
  const u = await seedUser('Gus', { religion: 'christian', politicalView: 'independent', drinkingHabit: 'never', dealbreakers: ['vaper'], intent: 'spark' })
  // Seeded values have no stamps: the first change is allowed (and stamps).
  expect(await write(u.uid, 'matching', { set: { religion: 'jewish', attractedTo: ['men'] }, stamp: ['religion', 'attractedTo'] })).toBe(200)
  expect(await write(u.uid, 'matching', { set: { religion: 'buddhist' }, stamp: ['religion'] })).toBe(403)

  // 29 days on: still locked. 31 days on: free again, for each field.
  const all = Object.keys(VALUES)
  await stampAgo(u.uid, all, 29)
  for (const f of all) expect(await write(u.uid, docOf(f), { set: { [f]: VALUES[f][2] }, stamp: [f] }), `${f} at 29 days`).toBe(403)
  await stampAgo(u.uid, all, 31)
  for (const f of all) expect(await write(u.uid, docOf(f), { set: { [f]: VALUES[f][2] }, stamp: [f] }), `${f} at 31 days`).toBe(200)
  for (const f of all) expect((await data(u.uid, docOf(f)))[f], f).toEqual(VALUES[f][2])
  // …and the new stamp locks it again (intent 'open' → 'play' with the Spark
  // profile still there: not a profile deletion).
  for (const f of all) expect(await write(u.uid, docOf(f), { set: { [f]: VALUES[f][1] }, stamp: [f] }), `${f} relocked`).toBe(403)
})

test('F-099: clearing is a change — it needs the stamp, and setting a value again then waits 30 days', async () => {
  const u = await seedUser('Hal', { religion: 'christian', drinkingHabit: 'socially', dealbreakers: ['vaper'] })
  // Removing the field, or setting it to null / an empty list.
  expect(await write(u.uid, 'matching', { del: ['religion'] })).toBe(403)
  expect(await write(u.uid, 'matching', { del: ['religion'], stamp: ['religion'] })).toBe(200)
  expect(await write(u.uid, 'matching', { set: { drinkingHabit: null }, stamp: ['drinkingHabit'] })).toBe(200)
  expect(await write(u.uid, 'matching', { set: { attractedTo: [] }, stamp: ['attractedTo'] })).toBe(200)
  expect(await write(u.uid, 'matching', { set: { dealbreakers: [] }, stamp: ['dealbreakers'] })).toBe(200)
  // Cleared, but not "never set": a new value waits for the clock.
  expect(await write(u.uid, 'matching', { set: { religion: 'jewish' } })).toBe(403)
  expect(await write(u.uid, 'matching', { set: { religion: 'jewish' }, stamp: ['religion'] })).toBe(403)
  expect(await write(u.uid, 'matching', { set: { drinkingHabit: 'never' }, stamp: ['drinkingHabit'] })).toBe(403)
  expect(await write(u.uid, 'matching', { set: { attractedTo: ['women'] }, stamp: ['attractedTo'] })).toBe(403)
  expect(await write(u.uid, 'matching', { set: { dealbreakers: ['vaper'] } })).toBe(403)
  const m = await data(u.uid, 'matching')
  expect(m.religion).toBeUndefined()
  expect(m.attractedTo).toEqual([])
})

test('F-099: the owner can\'t backdate, remove, add or replace the stamps, or stamp without a change', async () => {
  const u = await seedUser('Ivy', { religion: 'christian', intent: 'spark' })
  await stampAgo(u.uid, ['religion', 'intent'], 1)
  const old = new Date(Date.now() - 40 * DAY)
  // Backdating, with or without a change.
  expect(await write(u.uid, 'matching', { set: { 'fieldChangedAt.religion': old } })).toBe(403)
  expect(await write(u.uid, 'matching', { set: { religion: 'jewish', 'fieldChangedAt.religion': old } })).toBe(403)
  expect(await write(u.uid, 'profile', { set: { 'fieldChangedAt.intent': old } })).toBe(403)
  expect(await write(u.uid, 'profile', { set: { intent: 'open', 'fieldChangedAt.intent': old } })).toBe(403)
  // Removing one, or the whole map; replacing it with something else.
  expect(await write(u.uid, 'matching', { del: ['fieldChangedAt.religion'] })).toBe(403)
  expect(await write(u.uid, 'matching', { del: ['fieldChangedAt'] })).toBe(403)
  expect(await write(u.uid, 'profile', { del: ['fieldChangedAt'] })).toBe(403)
  expect(await write(u.uid, 'matching', { set: { fieldChangedAt: 'never' } })).toBe(403)
  // Keys that aren't limited fields; a fresh stamp with no change.
  expect(await write(u.uid, 'matching', { stamp: ['ageMin'] })).toBe(403)
  expect(await write(u.uid, 'profile', { stamp: ['mode'] })).toBe(403)
  expect(await write(u.uid, 'matching', { stamp: ['religion'] })).toBe(403)
  // Nothing moved.
  const stamp = await stampOf(u.uid, 'religion')
  expect(Math.abs(stamp.toMillis() - (Date.now() - DAY))).toBeLessThan(60_000)

  // A new doc can't arrive with stamps (the first values need none).
  const n = await blank('Nell')
  await db.doc(`users/${n.uid}/private/matching`).delete()
  await db.doc(`users/${n.uid}/private/profile`).delete()
  expect(await write(n.uid, 'matching', { set: { religion: 'jewish', 'fieldChangedAt.religion': old } })).toBe(403)
  expect(await write(n.uid, 'matching', { set: { religion: 'jewish' }, stamp: ['religion'] })).toBe(403)
  expect(await write(n.uid, 'profile', { set: { intent: 'spark' }, stamp: ['intent'] })).toBe(403)
  expect(await write(n.uid, 'matching', { set: { religion: 'jewish', ageMin: 25 } })).toBe(200)
  expect(await write(n.uid, 'profile', { set: { intent: 'spark', mode: 'spark' } })).toBe(200)
})

test('F-099: everything else on the two docs stays freely editable while the limited fields are locked; a reorder is a change to the rules', async () => {
  const u = await seedUser('Jo', { religion: 'christian', politicalView: 'independent', drinkingHabit: 'never', dealbreakers: ['vaper'], attractedTo: ['men', 'women'], intent: 'spark' })
  await stampAgo(u.uid, Object.keys(VALUES), 0)
  for (let i = 0; i < 2; i++) {
    expect(await write(u.uid, 'matching', { set: { ageMin: 25 + i, ageMax: 40 + i, radiusMiles: 10 + i, pronouns: i ? 'he/him' : 'they/them', showGender: i === 1 } })).toBe(200)
    expect(await write(u.uid, 'profile', { set: { mode: i ? 'spark' : 'play', onboardingPath: i ? 'spark' : 'both' } })).toBe(200)
  }
  // Re-sending the saved values with other changes is fine…
  expect(await write(u.uid, 'matching', { set: { religion: 'christian', attractedTo: ['men', 'women'], ageMin: 30 } })).toBe(200)
  expect(await write(u.uid, 'profile', { set: { intent: 'spark', mode: 'spark' } })).toBe(200)
  // …but a reordered list is a different value to the rules (the app sorts
  // and compares as sets before saving — see the app test below).
  expect(await write(u.uid, 'matching', { set: { attractedTo: ['women', 'men'] } })).toBe(403)
  expect(await data(u.uid, 'matching')).toMatchObject({ ageMin: 30, ageMax: 41, radiusMiles: 11, pronouns: 'he/him', showGender: true, attractedTo: ['men', 'women'] })
})

test('F-099: deleting a profile always moves the intent to the mode left (stamped); adding the mode back then waits', async () => {
  const PLAY = { playDisplayName: 'Ember', playBio: 'hi', spiceLevel: 'mild' }
  // Deleting Play (the callable removes playProfile/data, then the app writes the intent).
  const a = await seedUser('Kai', { intent: 'open', onboardingPath: 'both' }, { play: PLAY })
  await stampAgo(a.uid, ['intent'], 1)
  expect(await write(a.uid, 'profile', { set: { intent: 'spark' }, stamp: ['intent'] })).toBe(403) // Play still there
  await db.doc(`users/${a.uid}/playProfile/data`).delete()
  expect(await write(a.uid, 'profile', { set: { intent: 'spark' } })).toBe(403) // must stamp
  expect(await write(a.uid, 'profile', { set: { intent: 'spark', onboardingPath: 'spark', mode: 'spark' }, stamp: ['intent'] })).toBe(200)
  expect(await write(a.uid, 'profile', { set: { intent: 'open' }, stamp: ['intent'] })).toBe(403) // adding Play back waits
  expect(await write(a.uid, 'profile', { set: { intent: 'play' }, stamp: ['intent'] })).toBe(403) // not a narrowing

  // Deleting Spark: one batch drops sparkProfile/data and moves the intent.
  const b = await seedUser('Lux', { intent: 'open', onboardingPath: 'both' }, { play: { ...PLAY, playDisplayName: 'Velvet' } })
  await stampAgo(b.uid, ['intent'], 1)
  const toPlay = update(`users/${b.uid}/private/profile`, { set: { intent: 'play', onboardingPath: 'play', mode: 'play' }, stamp: ['intent'] })
  expect(await commit(b.uid, [toPlay])).toBe(403) // Spark profile still there
  expect(await commit(b.uid, [{ delete: `${DOCS}/users/${b.uid}/sparkProfile/data` }, toPlay])).toBe(200)
  expect((await data(b.uid, 'profile')).intent).toBe('play')
  expect(await stampOf(b.uid, 'intent')).toBeInstanceOf(Timestamp)
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
// "Reimagine my profile" opened at a step (by its index in the refresh flow),
// with `draft` over the saved profile — what a draft kept on the device does.
const REFRESH_STEPS = { attractedTo: 2, habits: 7, beliefs: 13, review: 24 }
async function refreshAt(page, uid, step, draft = {}) {
  await page.evaluate(
    ([u, i, d]) => localStorage.setItem(`zylove_onboarding_draft_refresh_${u}`, JSON.stringify({ v: 1, savedAt: Date.now(), stepIndex: i, data: { draft: d } })),
    [uid, REFRESH_STEPS[step], draft],
  )
  await page.goto('/onboarding?refresh=true')
}

test('F-099 app: a locked field shows the date it can change again and can\'t be changed; a reordered list saves as no change', async ({ browser }) => {
  const u = await seedUser('Mia', { religion: 'christian', drinkingHabit: 'never', attractedTo: ['women', 'men'] })
  await stampAgo(u.uid, ['religion', 'drinkingHabit'], 2)
  const until = dateOf(Date.now() - 2 * DAY + 30 * DAY)
  const { ctx, page, net } = await open(browser, u)

  await refreshAt(page, u.uid, 'beliefs', { religion: 'jewish' })
  await expect(page.getByRole('heading', { name: 'A little more about you' })).toBeVisible({ timeout: 20000 })
  // Religion: the saved answer (not the draft's), read-only, with the date.
  await expect(page.getByTestId('field-locked')).toHaveText(`You can change this again on ${until}.`)
  await expect(page.getByRole('button', { name: 'Christian' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Jewish' })).toBeDisabled()
  // Politics was never set: free.
  await expect(page.getByRole('button', { name: /^Independent/ })).toBeEnabled()

  await refreshAt(page, u.uid, 'habits')
  await expect(page.getByRole('heading', { name: 'My habits' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByLabel('Drinking')).toBeDisabled()
  await expect(page.getByTestId('field-locked')).toHaveText(`You can change this again on ${until}.`)

  // Attraction isn't locked; the same choices in another order save as no
  // change (no stamp, saved order untouched), and the locked religion stays.
  await refreshAt(page, u.uid, 'review', { attractedTo: ['men', 'women'], religion: 'jewish' })
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.waitForURL(/\/profile/, { timeout: 60000 })
  const m = await data(u.uid, 'matching')
  expect(m.attractedTo).toEqual(['women', 'men'])
  expect(m.fieldChangedAt.attractedTo).toBeUndefined()
  expect(m.religion).toBe('christian')
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('F-099 app: a save refused because a field locked meanwhile shows the date, not a generic error; an allowed change stamps', async ({ browser }) => {
  const u = await seedUser('Nia', { religion: 'christian', politicalView: 'independent' })
  const { ctx, page, net } = await open(browser, u)
  await refreshAt(page, u.uid, 'review', { religion: 'jewish', politicalView: 'democrat' })
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(1500) // the page has read the (unlocked) fields
  // Religion changes elsewhere (another device) after the page loaded.
  await stampAgo(u.uid, ['religion'], 0)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText(`You can change your religion again on ${dateOf(Date.now() + 30 * DAY)}.`)).toBeVisible({ timeout: 20000 })
  await expect(page.getByText(/Something went wrong|session needs refreshing/)).toHaveCount(0)
  expect((await data(u.uid, 'matching')).religion).toBe('christian')

  // Without the religion change, politics (set before, no stamp) changes and stamps.
  await refreshAt(page, u.uid, 'review', { politicalView: 'democrat' })
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.waitForURL(/\/profile/, { timeout: 60000 })
  const m = await data(u.uid, 'matching')
  expect(m.politicalView).toBe('democrat')
  expect(m.religion).toBe('christian')
  expect(m.fieldChangedAt.politicalView).toBeInstanceOf(Timestamp)
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('F-099 app: adding Play while the intent is locked shows the date and doesn\'t start', async ({ browser }) => {
  const u = await seedUser('Oli', { intent: 'spark' })
  await stampAgo(u.uid, ['intent'], 5)
  const { ctx, page, net } = await open(browser, u)
  await page.goto('/play-onboarding')
  await expect(page.getByTestId('field-locked')).toHaveText(`You can add a Play profile again on ${dateOf(Date.now() + 25 * DAY)}.`, { timeout: 20000 })
  await expect(page.getByRole('button', { name: "Let's go →" })).toBeDisabled()
  expect(net.errors).toEqual([])
  await ctx.close()
})
