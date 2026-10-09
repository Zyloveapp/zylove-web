// §4.A2 (2026-10): gender off the public doc. genderIdentity,
// genderSelfDescribe, pronouns and the display choices live in the
// owner-only users/{uid}/private/matching (gender identity-locked like
// matchableAs); the public doc carries only the server-built genderLine.
// Also F-098: "Trans women" attraction matches as women, and the migration
// (scripts/lib/a2gender.mjs).
import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, callAs, idTokenFor, db, userDoc, PROJECT, FieldValue,
} from './helpers.mjs'
import { applyA2, planA2, summaryA2 } from '../../scripts/lib/a2gender.mjs'

test.beforeEach(resetEmulators)

const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
async function rest(uid, path, init = {}) {
  const r = await fetch(`${BASE}/${path}`, { ...init, headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const fields = (o) => ({
  fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v } : { stringValue: v }])),
})
const get = (uid, path) => rest(uid, path)
const patch = async (uid, path, o) =>
  (await rest(uid, `${path}?${Object.keys(o).map((k) => `updateMask.fieldPaths=${k}`).join('&')}`, { method: 'PATCH', body: JSON.stringify(fields(o)) })).status
const matchingOf = async (uid) => (await db.doc(`users/${uid}/private/matching`).get()).data() ?? {}
const lineOf = async (uid) => (await userDoc(uid)).genderLine
const GENDER_KEYS = ['genderIdentity', 'genderSelfDescribe', 'pronouns', 'genderHidden', 'showGender']
const tara = () => seedUser('Tara', { genderIdentity: 'trans_woman', pronouns: 'she/her', attractedTo: ['men'] })

async function open(browser, user) {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, user.uid)
  await page.addInitScript((u) => sessionStorage.setItem(`zylove_profile_question_${u}`, '{}'), user.uid)
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page, net }
}

test('§4.A2: another signed-in user reads no gender fields — the public doc has only the line, private/matching is refused', async () => {
  const t = await tara()
  const viewer = await seedUser('Vic')
  const pub = await get(viewer.uid, `users/${t.uid}`)
  expect(pub.status).toBe(200)
  for (const k of GENDER_KEYS) expect(pub.body.fields[k]).toBeUndefined()
  expect(pub.body.fields.genderLine).toEqual({ stringValue: 'Trans woman · she/her' })
  expect((await get(viewer.uid, `users/${t.uid}/private/matching`)).status).toBe(403)
  // …nor the owner-only profile copies.
  expect((await get(viewer.uid, `users/${t.uid}/sparkProfile/data`)).status).toBe(403)
  // The owner reads their own.
  const own = await get(t.uid, `users/${t.uid}/private/matching`)
  expect(own.status).toBe(200)
  expect(own.body.fields.genderIdentity).toEqual({ stringValue: 'trans_woman' })
  expect(own.body.fields.pronouns).toEqual({ stringValue: 'she/her' })
})

test('§4.A2: clients can\'t write the gender fields or genderLine to the public doc, or anyone else\'s private/matching', async () => {
  const t = await tara()
  const other = await seedUser('Otto')
  for (const [k, v] of [['genderIdentity', 'woman'], ['genderSelfDescribe', 'x'], ['pronouns', 'she/her'], ['genderHidden', true], ['showGender', true], ['genderLine', 'Woman']]) {
    expect(await patch(t.uid, `users/${t.uid}`, { [k]: v }), k).toBe(403)
  }
  expect(await patch(other.uid, `users/${t.uid}/private/matching`, { pronouns: 'he/him' })).toBe(403)
  // Types: short strings, booleans.
  expect(await patch(t.uid, `users/${t.uid}/private/matching`, { pronouns: 'x'.repeat(41) })).toBe(403)
  expect(await patch(t.uid, `users/${t.uid}/private/matching`, { genderHidden: 'yes' })).toBe(403)
  expect(await patch(t.uid, `users/${t.uid}/private/matching`, { showGender: 1 })).toBe(403)
})

test('§4.A2: the identity lock — gender set once in private/matching, then refused; pronouns and display choices stay editable', async () => {
  // Locked (onboarded): gender and self-description refused, the rest fine.
  const t = await tara()
  expect(await patch(t.uid, `users/${t.uid}/private/matching`, { genderIdentity: 'woman' })).toBe(403)
  expect(await patch(t.uid, `users/${t.uid}/private/matching`, { genderSelfDescribe: 'Femme' })).toBe(403)
  expect(await patch(t.uid, `users/${t.uid}/private/matching`, { pronouns: 'she/they' })).toBe(200)
  expect(await patch(t.uid, `users/${t.uid}/private/matching`, { genderHidden: true })).toBe(200)
  expect((await matchingOf(t.uid)).genderIdentity).toBe('trans_woman')

  // Not locked yet: the first gender write is allowed and locks identity.
  const n = await seedUser('Nia', { genderIdentity: null })
  await db.doc(`users/${n.uid}`).update({ identityLockedAt: FieldValue.delete() })
  await expect.poll(async () => (await userDoc(n.uid)).identityLockedAt ?? null).toBe(null)
  expect(await patch(n.uid, `users/${n.uid}/private/matching`, { genderIdentity: 'nonbinary' })).toBe(200)
  await expect.poll(async () => (await userDoc(n.uid)).identityLockedAt != null, { timeout: 20000 }).toBe(true)
  expect(await patch(n.uid, `users/${n.uid}/private/matching`, { genderIdentity: 'woman' })).toBe(403)
  // …and identity-based Elite follows the lock.
  await expect.poll(async () => (await db.doc(`userInternal/${n.uid}`).get()).data()?.entitlement?.source ?? null, { timeout: 20000 }).toBe('identity')
})

test('§4.A2: the trigger writes the line — hidden is empty, man/woman only when shown, self-description sanitised', async () => {
  const t = await tara()
  expect(await lineOf(t.uid)).toBe('Trans woman · she/her')
  expect(await patch(t.uid, `users/${t.uid}/private/matching`, { pronouns: 'she/they' })).toBe(200)
  await expect.poll(() => lineOf(t.uid), { timeout: 20000 }).toBe('Trans woman · she/they')
  expect(await patch(t.uid, `users/${t.uid}/private/matching`, { genderHidden: true })).toBe(200)
  await expect.poll(() => lineOf(t.uid), { timeout: 20000 }).toBe('')

  const w = await seedUser('Wendy', { genderIdentity: 'woman', pronouns: 'she/her', attractedTo: ['men'] })
  expect(await lineOf(w.uid)).toBe('she/her')
  expect(await patch(w.uid, `users/${w.uid}/private/matching`, { showGender: true })).toBe(200)
  await expect.poll(() => lineOf(w.uid), { timeout: 20000 }).toBe('Woman · she/her')

  const s = await seedUser('Sky', { genderIdentity: 'self_describe', genderSelfDescribe: 'Two-spirit, call 5551234 or x.co', matchableAs: ['women'] })
  expect(await lineOf(s.uid)).toBe('Two-spirit, call or xco')
  const m = await seedUser('Max')
  expect(await lineOf(m.uid)).toBe('')
})

test('§4.A2 / F-098: Explore still matches by matchableAs; cards carry only the line; "Trans women" attraction matches women', async () => {
  const viewer = await seedUser('Vince') // man, attracted to women
  const ag = await seedUser('Ari', { genderIdentity: 'agender', matchableAs: ['women'], attractedTo: ['men'] })
  const nb = await seedUser('Nico', { genderIdentity: 'agender', matchableAs: ['nonbinary_people'], attractedTo: ['men'] })
  const w = await seedUser('Willa', { genderIdentity: 'woman', attractedTo: ['men'] })
  const r = await callAs(viewer.uid, 'getExploreDeck', { mode: 'spark' })
  const ids = r.cards.map((c) => c.uid)
  expect(ids).toEqual(expect.arrayContaining([ag.uid, w.uid]))
  expect(ids).not.toContain(nb.uid)
  for (const c of r.cards) for (const k of GENDER_KEYS) expect(c.profile[k], k).toBeUndefined()
  expect(r.cards.find((c) => c.uid === ag.uid).profile.genderLine).toBe('Agender')

  // Attracted only to trans women: cis and trans women alike, in Explore and the score.
  const seeker = await seedUser('Sol', { attractedTo: ['trans_women'] })
  const t = await tara()
  const deck = (await callAs(seeker.uid, 'getExploreDeck', { mode: 'spark' })).cards.map((c) => c.uid)
  expect(deck).toEqual(expect.arrayContaining([w.uid, t.uid]))
})

test('§4.A2: the migration moves gender off the public doc (private value wins), writes the line, scrubs copies; idempotent', async () => {
  const a = await seedUser('Ana', { genderIdentity: 'woman', attractedTo: ['men'] })
  const b = await seedUser('Bo', { genderIdentity: 'nonbinary', attractedTo: ['women'] })
  // Back to the old layout: gender on the public doc and the Spark copy.
  await db.doc(`users/${a.uid}`).update({ genderIdentity: 'trans_woman', pronouns: 'she/her', genderHidden: true, genderLine: FieldValue.delete() })
  await db.doc(`users/${a.uid}/private/matching`).update({ genderIdentity: FieldValue.delete(), pronouns: FieldValue.delete(), genderHidden: FieldValue.delete() })
  await db.doc(`users/${a.uid}/sparkProfile/data`).set({ genderIdentity: 'trans_woman', pronouns: 'she/her' }, { merge: true })
  // A conflict: the public copy differs from the private one, which wins.
  await db.doc(`users/${b.uid}`).update({ genderIdentity: 'man', pronouns: 'they/them' })
  // Let the triggers from those admin writes settle first.
  await expect.poll(async () => (await userDoc(a.uid)).genderLine !== undefined, { timeout: 20000 }).toBe(true)

  const plan = await planA2({ db })
  const s = summaryA2(plan)
  expect(s['genderIdentity: on public doc']).toBe(2)
  expect(s['genderIdentity: moved']).toBe(1)
  expect(s['genderIdentity: conflict (private value kept)']).toBe(1)
  expect(s['pronouns: moved']).toBe(2)
  expect(s['genderHidden: moved']).toBe(1)
  expect(s['sparkProfile copies scrubbed']).toBe(1)
  expect(Object.keys(plan.backup)).toEqual(expect.arrayContaining([`users/${a.uid}`, `users/${b.uid}`, `users/${a.uid}/sparkProfile/data`]))
  await applyA2({ db, FieldValue }, plan)

  const ra = await userDoc(a.uid)
  for (const k of GENDER_KEYS) expect(ra[k]).toBeUndefined()
  expect(ra.genderLine).toBe('') // hidden
  expect(await matchingOf(a.uid)).toMatchObject({ genderIdentity: 'trans_woman', pronouns: 'she/her', genderHidden: true })
  expect((await db.doc(`users/${a.uid}/sparkProfile/data`).get()).data().genderIdentity).toBeUndefined()
  expect((await matchingOf(b.uid)).genderIdentity).toBe('nonbinary')
  expect((await userDoc(b.uid)).genderLine).toBe('Non-binary · they/them')
  const again = summaryA2(await planA2({ db }))
  for (const [k, n] of Object.entries(again)) if (!k.startsWith('report')) expect(n, k).toBe(0)
})

test('§4.A2: the UI shows another person the line; the owner edits their own values', async ({ browser }) => {
  const t = await tara()
  const viewer = await seedUser('Vic')
  const v = await open(browser, viewer)
  await v.page.goto(`/profile/${t.uid}`)
  await expect(v.page.getByRole('heading', { name: 'Tara, 30' })).toBeVisible()
  await expect(v.page.getByText('Trans woman · she/her')).toBeVisible()
  expect(v.net.errors).toEqual([])
  await v.ctx.close()

  // The owner: their own values in Edit profile, from private/matching.
  const o = await open(browser, t)
  await o.page.goto('/profile/edit')
  const pronouns = o.page.getByPlaceholder('e.g. she/her, they/them')
  await expect(pronouns).toHaveValue('she/her')
  await expect(o.page.getByText('Trans woman', { exact: true })).toBeVisible() // the locked Gender field
  await pronouns.fill('she/they')
  await o.page.getByRole('button', { name: 'Save Spark profile' }).click()
  await expect(o.page.getByText(/Saved ✦/)).toBeVisible()
  await expect.poll(async () => (await matchingOf(t.uid)).pronouns).toBe('she/they')
  await expect.poll(() => lineOf(t.uid), { timeout: 20000 }).toBe('Trans woman · she/they')
  expect((await userDoc(t.uid)).pronouns).toBeUndefined()
  expect(o.net.errors).toEqual([])
  await o.ctx.close()

  // A man chooses to show his gender.
  const m = await seedUser('Milo')
  const mo = await open(browser, m)
  await mo.page.goto('/profile/edit')
  await expect(mo.page.getByRole('checkbox', { name: /Don't show my gender/ })).toHaveCount(0)
  await mo.page.getByRole('checkbox', { name: /Show my gender on my profile/ }).check()
  await mo.page.getByRole('button', { name: 'Save Spark profile' }).click()
  await expect(mo.page.getByText(/Saved ✦/)).toBeVisible()
  await expect.poll(() => lineOf(m.uid), { timeout: 20000 }).toBe('Man')
  await mo.ctx.close()
})
