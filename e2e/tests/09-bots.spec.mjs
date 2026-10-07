import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, db, likeAs, PHOTO, Timestamp, sortedPair } from './helpers.mjs'

const require = createRequire(import.meta.url)
require('../stub-anthropic.cjs') // this process runs processBotLikeBacks directly
const WEB_FN = new URL('../web-fn/', import.meta.url).pathname
const fnRequire = createRequire(`${WEB_FN}package.json`)
function botJobs() {
  const app = fnRequire('firebase-admin/app')
  if (!app.getApps().length) app.initializeApp({ projectId: 'demo-zylove', storageBucket: 'demo-zylove.appspot.com' })
  return fnRequire(`${WEB_FN}lib/botLikeBack.js`)
}

test.beforeEach(resetEmulators)

async function seedBot(uid, name) {
  await db.doc(`users/${uid}`).set({
    uid, displayName: name, age: 29, genderIdentity: 'woman', attractedTo: ['men'], intent: 'spark', isBot: true,
    bio: 'Coffee, climbing, and bad puns.', promptAnswers: [{ promptId: 'green_flag', answer: 'Kindness' }],
    photoURLs: [PHOTO], sparkVisibility: 'active', playVisibility: 'hidden', onboardingComplete: true, isSuspended: false,
    publicKey: 'seed-stub-key', locationLat: 30.27, locationLng: -97.74, locationLabel: 'Austin, TX', sortKey: Math.random(),
    ageMin: 21, ageMax: 45, subscriptionTier: 'elite',
  })
}

test('bots: like a bot → like-back after the delay → match with opener → bot replies in chat', async ({ browser }) => {
  const human = await seedUser('Hale')
  const bot = 'zbot-e2e-1'
  await seedBot(bot, 'Ivy')
  await likeAs(human.uid, bot)

  // queueBotLikeBack: a pending like-back, due 5 minutes out.
  const pendingRef = db.doc(`pendingBotLikes/${bot}_${human.uid}`)
  await expect.poll(async () => (await pendingRef.get()).exists, { timeout: 20000 }).toBe(true)
  expect((await pendingRef.get()).data().dueAt.toMillis()).toBeGreaterThan(Date.now() + 4 * 60000)

  // processBotLikeBacks (every minute in production): once due, it matches and opens.
  await pendingRef.update({ dueAt: Timestamp.fromMillis(Date.now() - 1000) })
  await botJobs().processBotLikeBacks.run({})
  const matchId = sortedPair(human.uid, bot)
  const match = (await db.doc(`matches/${matchId}`).get()).data()
  expect(match?.isBot).toBe(true)
  expect(match?.users).toContain(human.uid)
  await expect.poll(async () => (await db.collection(`matches/${matchId}/messages`).where('senderId', '==', bot).get()).size, { timeout: 20000 }).toBeGreaterThan(0)
  expect((await pendingRef.get()).exists).toBe(false)

  // The human sees the opener, replies, and the bot answers (onBotMessage).
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, human.uid)
  await page.addInitScript((m) => localStorage.setItem(`zylove_chat_seen_${m}`, '1'), matchId)
  await signIn(page, human.phone, { expectPath: /\/discover/ })
  await page.goto(`/chat/${matchId}`)
  await expect(page.getByText('E2E stub reply 👋').first()).toBeVisible({ timeout: 20000 }) // the opener
  const box = page.getByPlaceholder('Message Ivy…')
  await box.fill('hey Ivy, how was climbing?')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(async () => (await db.collection(`matches/${matchId}/messages`).where('senderId', '==', bot).get()).size, { timeout: 30000 }).toBeGreaterThan(1)
  await expect(page.getByText('E2E stub reply 👋')).toHaveCount(2, { timeout: 20000 })
  expect(net.errors).toEqual([])
  await ctx.close()
})
