import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, db, Timestamp, sortedPair, userDoc } from './helpers.mjs'

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

async function device(browser, user, { keyBackup = true } = {}) {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, user.uid, { keyBackup })
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page, net }
}

async function send(page, partner, text) {
  const box = page.getByPlaceholder(`Message ${partner}…`)
  await expect(box).toBeVisible({ timeout: 20000 })
  await box.fill(text)
  const btn = page.getByRole('button', { name: 'Send', exact: true })
  await expect(btn).toBeEnabled({ timeout: 20000 })
  await btn.click()
}

test('chat: end-to-end encrypted messages both ways', async ({ browser }) => {
  const a = await seedUser('Harper')
  const b = await seedUser('Indy', { genderIdentity: 'woman', attractedTo: ['men'] })
  const matchId = await seedMatch(a, b)
  const A = await device(browser, a)
  const B = await device(browser, b)
  // Both browsers generated a keypair and published the public key.
  await expect.poll(async () => (await userDoc(a.uid)).publicKey?.length ?? 0).toBeGreaterThan(20)
  await expect.poll(async () => (await userDoc(b.uid)).publicKey?.length ?? 0).toBeGreaterThan(20)

  await A.page.goto(`/chat/${matchId}`)
  await send(A.page, 'Indy', 'hello from Harper')
  await B.page.goto(`/chat/${matchId}`)
  await expect(B.page.getByText('hello from Harper')).toBeVisible({ timeout: 20000 })
  await send(B.page, 'Harper', 'hi Harper, Indy here')
  await expect(A.page.getByText('hi Harper, Indy here')).toBeVisible({ timeout: 20000 })

  // Stored encrypted: no plaintext in Firestore, real nonces.
  const msgs = (await db.collection(`matches/${matchId}/messages`).get()).docs.map((d) => d.data())
  expect(msgs).toHaveLength(2)
  for (const m of msgs) {
    expect(m.nonce).not.toBe('stub')
    expect(m.ciphertext).not.toContain('Harper')
    expect(m.ciphertext).not.toContain('Indy')
  }
  expect(A.net.errors).toEqual([])
  expect(B.net.errors).toEqual([])
  await A.ctx.close()
  await B.ctx.close()
})

test('chat: PIN backup → second device unlocks and reads history', async ({ browser }) => {
  const a = await seedUser('Jules')
  const b = await seedUser('Kai', { genderIdentity: 'woman', attractedTo: ['men'] })
  const matchId = await seedMatch(a, b)

  // Device 1: the backup prompt appears; set a chat PIN.
  const A1 = await device(browser, a, { keyBackup: false })
  await expect(A1.page.getByText('Protect your chats')).toBeVisible({ timeout: 20000 })
  await A1.page.getByLabel('New chat PIN').fill('4817')
  await A1.page.getByRole('button', { name: 'Next' }).click()
  await A1.page.getByLabel('Confirm chat PIN').fill('4817')
  await A1.page.getByRole('button', { name: 'Save PIN' }).click()
  await expect(A1.page.getByText(/Your chats are protected/)).toBeVisible({ timeout: 20000 })
  await A1.page.getByRole('button', { name: 'Done' }).click()

  const B = await device(browser, b)
  await A1.page.goto(`/chat/${matchId}`)
  await send(A1.page, 'Kai', 'message before switching devices')
  await B.page.goto(`/chat/${matchId}`)
  await expect(B.page.getByText('message before switching devices')).toBeVisible({ timeout: 20000 })
  await A1.ctx.close()

  // Device 2: a fresh browser for the same account asks for the PIN.
  const A2 = await device(browser, a, { keyBackup: false })
  await expect(A2.page.getByText('Unlock your chats')).toBeVisible({ timeout: 20000 })
  await A2.page.getByLabel('Chat PIN').fill('4817')
  await A2.page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(A2.page.getByText('Unlock your chats')).toBeHidden({ timeout: 20000 })
  await A2.page.goto(`/chat/${matchId}`)
  await expect(A2.page.getByText('message before switching devices')).toBeVisible({ timeout: 20000 })
  await send(A2.page, 'Kai', 'and from my second device')
  await expect(B.page.getByText('and from my second device')).toBeVisible({ timeout: 20000 })
  await A2.ctx.close()
  await B.ctx.close()
})
