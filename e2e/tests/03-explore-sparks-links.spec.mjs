import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, db, likeAs } from './helpers.mjs'

test.beforeEach(resetEmulators)

async function open(browser, user) {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  if (process.env.E2E_CONSOLE) page.on('console', (m) => console.log(`[browser:${m.type()}]`, m.text().slice(0, 300)))
  await quietFirstRun(page, user.uid)
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page, net }
}

// Shows Blair (skipping others with "Maybe", which requeues locally) and likes her.
async function likeBlair(page) {
  for (let i = 0; i < 6; i++) {
    const h = page.getByRole('heading', { name: /^(Blair|Cleo)\b/ }).first()
    await expect(h).toBeVisible({ timeout: 30000 })
    if ((await h.innerText()).startsWith('Blair')) break
    await page.getByRole('button', { name: 'Maybe' }).filter({ visible: true }).first().click()
  }
  await page.getByRole('button', { name: "I'm Interested" }).filter({ visible: true }).first().click()
}

test('explore: candidate shows, like → mutual match overlay → Links', async ({ browser }) => {
  const viewer = await seedUser('Alex')
  const cand = await seedUser('Blair', { genderIdentity: 'woman', attractedTo: ['men'], subscriptionTier: 'elite' })
  await seedUser('Cleo', { genderIdentity: 'woman', attractedTo: ['men'] }) // another card stays in the deck
  // Blair already liked Alex, through the real callables.
  await likeAs(cand.uid, viewer.uid)
  const { ctx, page, net } = await open(browser, viewer)
  await likeBlair(page)
  await expect(page.getByRole('dialog', { name: 'Sparks are flying' })).toBeVisible({ timeout: 30000 })
  await expect.poll(async () => (await db.collection('matches').where('users', 'array-contains', viewer.uid).get()).size, { timeout: 20000 }).toBe(1)
  await page.getByRole('button', { name: 'Chat later' }).click()
  await page.getByRole('link', { name: 'Links' }).click()
  await expect(page.getByText('Blair').first()).toBeVisible()
  expect(net.errors).toEqual([])
  await ctx.close()
})

// B-001 regression: matching with the LAST profile in the deck still shows
// the overlay (it used to be skipped by the empty-deck screen).
test('explore: match on the last card shows the overlay (B-001)', async ({ browser }) => {
  const viewer = await seedUser('Alex')
  const cand = await seedUser('Blair', { genderIdentity: 'woman', attractedTo: ['men'] })
  await likeAs(cand.uid, viewer.uid)
  const { ctx, page } = await open(browser, viewer)
  await likeBlair(page)
  await expect.poll(async () => (await db.collection('matches').where('users', 'array-contains', viewer.uid).get()).size, { timeout: 20000 }).toBe(1)
  await expect(page.getByRole('dialog', { name: 'Sparks are flying' })).toBeVisible({ timeout: 8000 })
  // Behind it, the deck is empty; closing it leaves the empty state.
  await page.getByRole('button', { name: 'Chat later' }).click()
  await expect(page.getByText("You've seen everyone for now")).toBeVisible()
  await ctx.close()
})

test('explore: pass advances to the next profile', async ({ browser }) => {
  const viewer = await seedUser('Casey')
  await seedUser('Dana', { genderIdentity: 'woman', attractedTo: ['men'] })
  await seedUser('Emery', { genderIdentity: 'woman', attractedTo: ['men'] })
  const { ctx, page } = await open(browser, viewer)
  const name = page.getByRole('heading', { name: /^(Dana|Emery)/ }).first()
  await expect(name).toBeVisible({ timeout: 30000 })
  const first = (await name.innerText()).split(',')[0]
  await page.getByRole('button', { name: 'Not Interested' }).filter({ visible: true }).first().click()
  await expect(page.getByRole('heading', { name: new RegExp(`^${first === 'Dana' ? 'Emery' : 'Dana'}`) }).first()).toBeVisible({ timeout: 20000 })
  await ctx.close()
})

test('sparks: incoming like → like back → match', async ({ browser }) => {
  const me = await seedUser('Finley', { genderIdentity: 'woman', attractedTo: ['men'] })
  const liker = await seedUser('Gray')
  // Gray likes Finley through the real callables (onLike fills her likeQueue).
  await likeAs(liker.uid, me.uid)
  const { ctx, page, net } = await open(browser, me)
  await page.getByRole('link', { name: 'Sparks' }).click()
  await expect(page.getByText('✦ Sparks ✦')).toBeVisible()
  await page.getByRole('button', { name: /compatibility report is ready/ }).first().click()
  await page.getByRole('button', { name: "It's a Spark" }).click()
  await expect(page.getByRole('dialog', { name: 'Sparks are flying' })).toBeVisible({ timeout: 30000 })
  await expect.poll(async () => (await db.collection('matches').where('users', 'array-contains', me.uid).get()).size, { timeout: 20000 }).toBe(1)
  expect(net.errors).toEqual([])
  await ctx.close()
})
