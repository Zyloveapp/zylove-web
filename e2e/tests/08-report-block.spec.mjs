import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, db, Timestamp, sortedPair } from './helpers.mjs'

test.beforeEach(resetEmulators)

async function seedMatch(a, b) {
  const id = sortedPair(a.uid, b.uid)
  await db.doc(`matches/${id}`).set({
    matchId: id, users: [a.uid, b.uid].sort(), participants: [a.uid, b.uid].sort(), mode: 'spark',
    matchedAt: Timestamp.now(), createdAt: Timestamp.now(), matchGeneration: Date.now(), isBlocked: false, safetyCardShown: true,
    participantSnapshots: { [a.uid]: { displayName: a.name, age: 30 }, [b.uid]: { displayName: b.name, age: 30 } },
  })
  return id
}

async function open(browser, user) {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, user.uid)
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page, net }
}

test('report: report a match from chat → report stored', async ({ browser }) => {
  const a = await seedUser('Bea')
  const b = await seedUser('Cruz', { genderIdentity: 'woman', attractedTo: ['men'] })
  const matchId = await seedMatch(a, b)
  const { ctx, page, net } = await open(browser, a)
  await page.goto(`/chat/${matchId}`)
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('button', { name: 'Report Cruz' }).click()
  await page.getByRole('button', { name: /I felt unsafe/ }).click()
  await page.getByRole('button', { name: 'Send report' }).click()
  await expect(page.getByText(/Report sent/)).toBeVisible()
  await expect.poll(async () => (await db.collection('reports').where('reportedUid', '==', b.uid).get()).size).toBe(1)
  const r = (await db.collection('reports').where('reportedUid', '==', b.uid).get()).docs[0].data()
  expect(r.reporterUid).toBe(a.uid)
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('block: block from chat (blockUser) → hidden both ways; unblock from Settings', async ({ browser }) => {
  const a = await seedUser('Dale')
  const b = await seedUser('Echo', { genderIdentity: 'woman', attractedTo: ['men'] })
  const matchId = await seedMatch(a, b)
  const { ctx, page, net } = await open(browser, a)
  await page.goto(`/chat/${matchId}`)
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('button', { name: 'Block Echo' }).click()
  await page.getByRole('button', { name: 'Block', exact: true }).click()
  await expect.poll(async () => (await db.doc(`matches/${matchId}`).get()).data()?.isBlocked).toBe(true)
  expect((await db.doc(`users/${a.uid}/blockedUsers/${b.uid}`).get()).exists).toBe(true)
  expect((await db.doc(`users/${b.uid}/blockedUsers/${a.uid}`).get()).exists).toBe(true)
  // Gone from Links.
  await page.goto('/matches')
  await expect(page.getByText('No connections yet')).toBeVisible()
  // Unblock from Settings → Blocked users (web unblockMember).
  await page.goto('/settings/blocked')
  await expect(page.getByRole('heading', { name: 'Blocked users' })).toBeVisible()
  await page.getByRole('button', { name: 'Unblock' }).first().click()
  await expect(page.getByText(/Unblock Echo\?/)).toBeVisible()
  await page.getByRole('button', { name: 'Unblock', exact: true }).last().click()
  await expect.poll(async () => (await db.doc(`users/${a.uid}/blockedUsers/${b.uid}`).get()).exists).toBe(false)
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('block: unblockUser callable (mobile path) lifts a block', async () => {
  const { callAs } = await import('./helpers.mjs')
  const a = await seedUser('Fox')
  const b = await seedUser('Gil', { genderIdentity: 'woman', attractedTo: ['men'] })
  const matchId = await seedMatch(a, b)
  await callAs(a.uid, 'blockUser', { targetUid: b.uid, matchId })
  expect((await db.doc(`users/${a.uid}/blockedUsers/${b.uid}`).get()).exists).toBe(true)
  await callAs(a.uid, 'unblockUser', { targetUid: b.uid })
  expect((await db.doc(`users/${a.uid}/blockedUsers/${b.uid}`).get()).exists).toBe(false)
})
