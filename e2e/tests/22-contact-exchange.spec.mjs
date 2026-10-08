// Trust & Safety Phase 3 (2026-10): Share contact — the state machine,
// rule refusals (cards only while accepted, never before both people sent 3
// messages), revoke, request-timing signals, blocking and masking raw
// contact details on the device, and the two-device flow end to end.
import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, sortedPair, signIn, offline, quietFirstRun, CONTEXT, userDoc, Timestamp, PROJECT, playIdOf, setPlan,
} from './helpers.mjs'

test.beforeEach(resetEmulators)

const DOCS = `projects/${PROJECT}/databases/(default)/documents`
const BASE = `http://127.0.0.1:8390/v1/${DOCS}`
const headers = async (uid) => ({ Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' })
const value = (v) =>
  v === null ? { nullValue: null }
  : typeof v === 'string' ? { stringValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'boolean' ? { booleanValue: v }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } }
const fields = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, value(v)]))
async function sendAs(uid, matchId, data) {
  const r = await fetch(`${BASE}:commit`, {
    method: 'POST',
    headers: await headers(uid),
    body: JSON.stringify({
      writes: [{
        update: { name: `${DOCS}/matches/${matchId}/messages/m${Math.random().toString(36).slice(2)}`, fields: fields({ senderId: uid, status: 'sent', ...data }) },
        currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'sentAt', setToServerValue: 'REQUEST_TIME' }],
      }],
    }),
  })
  return r.status
}
const card = { messageType: 'contact_card', ciphertext: 'c2VhbGVkLWNhcmQ=', nonce: 'bm9uY2U=' }
const woman = (name, o = {}, opts) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o }, opts)
async function matchOf(a, b) {
  await likeAs(a.uid, b.uid)
  expect((await likeAs(b.uid, a.uid)).matched).toBe(true)
  return sortedPair(a.uid, b.uid)
}
// F-062: a Play match (pm_…) is playMatches/{id}, its senders Play IDs.
const col = (matchId) => (matchId.startsWith('pm_') ? 'playMatches' : 'matches')
const say = (matchId, senderId, n) =>
  Promise.all(Array.from({ length: n }, (_, i) => db.collection(`${col(matchId)}/${matchId}/messages`).add({ senderId, messageType: 'text', ciphertext: 'x', nonce: 'n', status: 'sent', sentAt: new Date(Date.now() + i) })))
const ce = async (id) => (await db.doc(`${col(id)}/${id}`).get()).data().contactExchange
const notices = async (id) =>
  (await db.collection(`matches/${id}/messages`).where('messageType', '==', 'contact_request').get()).docs.map((d) => d.data()).sort((a, b) => a.sentAt.toMillis() - b.sentAt.toMillis()).map((m) => m.ciphertext)

test('state machine: unlock after 3 messages each, accept, cards only while accepted, revoke blanks them, share back', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await matchOf(a, b)
  // Nothing yet: no card, no request.
  expect(await sendAs(a.uid, id, card)).toBe(403)
  await expect(callAs(a.uid, 'requestContactExchange', { matchId: id })).rejects.toThrow(/both sent 3 messages/)
  await say(id, a.uid, 3)
  await say(id, b.uid, 2)
  await expect(callAs(a.uid, 'requestContactExchange', { matchId: id })).rejects.toThrow(/both sent 3 messages/) // Bea has 2
  await say(id, b.uid, 1)
  await callAs(a.uid, 'requestContactExchange', { matchId: id })
  expect(await ce(id)).toMatchObject({ status: 'pending', requestedBy: a.uid })
  expect(await notices(id)).toEqual(['contact_request'])
  // Clients can't move the state or write the notices themselves.
  const patch = await fetch(`${BASE}/matches/${id}?updateMask.fieldPaths=contactExchange`, { method: 'PATCH', headers: await headers(b.uid), body: JSON.stringify({ fields: fields({ contactExchange: { status: 'accepted', requestedBy: a.uid } }) }) })
  expect(patch.status).toBe(403)
  expect(await sendAs(b.uid, id, { messageType: 'contact_request', ciphertext: 'contact_accepted', nonce: 'system' })).toBe(403)
  expect(await sendAs(a.uid, id, card)).toBe(403) // still pending
  await expect(callAs(a.uid, 'requestContactExchange', { matchId: id })).rejects.toThrow(/already waiting/)
  await expect(callAs(a.uid, 'respondContactExchange', { matchId: id, accept: true })).rejects.toThrow(/your own request/)

  // Bea: receive only.
  await callAs(b.uid, 'respondContactExchange', { matchId: id, accept: true, shareBack: false })
  expect(await ce(id)).toMatchObject({ status: 'accepted', shareBack: false })
  expect(await sendAs(a.uid, id, card)).toBe(200)
  expect(await sendAs(b.uid, id, card)).toBe(403) // she chose not to share back
  expect(await sendAs(a.uid, id, { ...card, nonce: 'stub' })).toBe(403) // never plaintext
  expect(await sendAs(a.uid, id, { ...card, ciphertext: '' })).toBe(403)

  // Bea takes it back: every card is blanked, a notice says so.
  const r = await callAs(b.uid, 'revokeContactExchange', { matchId: id })
  expect(r.cardsRemoved).toBe(1)
  expect(await ce(id)).toMatchObject({ status: 'revoked', revokedBy: b.uid })
  const cards = (await db.collection(`matches/${id}/messages`).where('messageType', '==', 'contact_card').get()).docs.map((d) => d.data())
  expect(cards).toEqual([expect.objectContaining({ ciphertext: '', nonce: 'revoked' })])
  expect(await sendAs(a.uid, id, card)).toBe(403)

  // Asking again; this time Bea shares back.
  await callAs(b.uid, 'requestContactExchange', { matchId: id })
  await callAs(a.uid, 'respondContactExchange', { matchId: id, accept: true, shareBack: true })
  expect(await sendAs(a.uid, id, card)).toBe(200)
  expect(await sendAs(b.uid, id, card)).toBe(200)
  expect(await notices(id)).toEqual(['contact_request', 'contact_accepted', 'contact_revoked', 'contact_request', 'contact_accepted'])

  // Declining.
  await callAs(a.uid, 'revokeContactExchange', { matchId: id })
  await callAs(a.uid, 'requestContactExchange', { matchId: id })
  await callAs(b.uid, 'respondContactExchange', { matchId: id, accept: false })
  expect((await ce(id)).status).toBe('declined')
  expect(await sendAs(a.uid, id, card)).toBe(403)

  // Counts only, for the risk score.
  const s = (await db.doc(`behaviorSignals/${a.uid}`).get()).data().contactRequests
  expect(s.total).toBe(2)
  expect(s.recent).toHaveLength(2)
  expect(JSON.stringify(s)).not.toMatch(/phone|instagram|snap/i)
})

test('who: either person, Spark and Play; never with a curated profile or after the chat ended', async () => {
  const PLAY = (n) => ({ playDisplayName: n, playBio: 'b', spiceLevel: 'mild' })
  const a = await seedUser('Ann', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ann') })
  const b = await woman('Bea', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Bea') })
  for (const u of [a, b]) await setPlan(u.uid, 'elite') // Play, set the way the server decides it
  await likeAs(a.uid, b.uid, 'play')
  const { matchId: play } = await likeAs(b.uid, a.uid, 'play')
  expect(play).toMatch(/^pm_/)
  const [aPlay, bPlay] = [await playIdOf(a.uid), await playIdOf(b.uid)]
  await db.doc(`playMatches/${play}`).update({ matchGeneration: Date.now() - 1000 })
  await say(play, aPlay, 3)
  await say(play, bPlay, 3)
  await callAs(b.uid, 'requestContactExchange', { matchId: play }) // the other person can start too
  expect((await ce(play)).requestedBy).toBe(bPlay) // F-062: by Play ID

  const bot = 'zbot-e2e-contact'
  const botMatch = sortedPair(a.uid, bot)
  await db.doc(`matches/${botMatch}`).set({ users: [a.uid, bot].sort(), participants: [a.uid, bot].sort(), isBot: true, mode: 'spark', matchedAt: Timestamp.now() })
  await say(botMatch, a.uid, 3)
  await say(botMatch, bot, 3)
  await expect(callAs(a.uid, 'requestContactExchange', { matchId: botMatch })).rejects.toThrow(/curated profile/)

  await db.doc(`playMatches/${play}`).update({ isBlocked: true })
  await expect(callAs(a.uid, 'respondContactExchange', { matchId: play, accept: true })).rejects.toThrow(/ended/)
  const stranger = await seedUser('Cal')
  await expect(callAs(stranger.uid, 'requestContactExchange', { matchId: play })).rejects.toThrow(/Not a participant/)
})

// ─── On the devices ──────────────────────────────────────────────────────────

async function seedMatch(a, b) {
  const id = sortedPair(a.uid, b.uid)
  await db.doc(`matches/${id}`).set({
    matchId: id, users: [a.uid, b.uid].sort(), participants: [a.uid, b.uid].sort(), mode: 'spark',
    matchedAt: Timestamp.now(), createdAt: Timestamp.now(), matchGeneration: Date.now() - 1000, isBlocked: false, safetyCardShown: true,
    participantSnapshots: { [a.uid]: { displayName: a.name, age: 30 }, [b.uid]: { displayName: b.name, age: 30 } },
  })
  return id
}
async function device(browser, user) {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, user.uid)
  await signIn(page, user.phone, { expectPath: /\/discover/ })
  return { ctx, page, net }
}
async function send(page, partner, text) {
  const box = page.getByPlaceholder(`Message ${partner}…`)
  await expect(box).toBeVisible({ timeout: 20000 })
  await box.fill(text)
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 20000 })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

test('chat: raw contact details stay on the device; Share contact locked → request → receive and share back → cards both ways → take back', async ({ browser }) => {
  const a = await seedUser('Ada')
  const b = await woman('Bea')
  const id = await seedMatch(a, b)
  const A = await device(browser, a)
  const B = await device(browser, b)
  for (const u of [a, b]) await expect.poll(async () => (await userDoc(u.uid)).publicKey?.length ?? 0, { timeout: 20000 }).toBeGreaterThan(20)
  await A.page.goto(`/chat/${id}`)
  await B.page.goto(`/chat/${id}`)

  // Raw details are refused on the sender's device, pointing to Share contact.
  await send(A.page, 'Bea', 'call me 512-555-0134')
  await expect(A.page.getByText(/Phone numbers, handles and emails can't be sent in chat — use Share contact/)).toBeVisible()
  // Locked until both sent 3.
  await A.page.getByRole('button', { name: 'Share contact' }).click()
  await expect(A.page.getByText(/unlocks once you've both sent 3 messages \(you 0\/3 · Bea 0\/3\)/)).toBeVisible()
  for (const t of ['hi Bea', 'how was your day?', 'any plans this weekend?']) await send(A.page, 'Bea', t)
  for (const t of ['hey Ada', 'pretty good!', 'hiking maybe']) await send(B.page, 'Ada', t)
  await expect(A.page.getByText('hiking maybe')).toBeVisible({ timeout: 20000 })

  // Ada offers her phone number.
  await A.page.getByRole('button', { name: 'Share contact' }).click()
  const sheet = A.page.getByRole('dialog', { name: 'Share contact with Bea' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText(/email/i)).toHaveCount(0) // no email on a card
  await sheet.getByLabel('Phone number').first().check()
  await sheet.getByRole('textbox', { name: 'Phone number' }).fill('(512) 555-0134')
  await sheet.getByRole('button', { name: 'Send request' }).click()
  await expect(sheet).toBeHidden()
  await expect.poll(async () => (await ce(id))?.status, { timeout: 20000 }).toBe('pending')
  // Nothing of hers is in the chat before Bea accepts.
  expect((await db.collection(`matches/${id}/messages`).where('messageType', '==', 'contact_card').get()).size).toBe(0)

  // Bea sees the request with the safety note, and shares her Instagram back.
  await expect(B.page.getByText('Ada wants to share contact details with you.')).toBeVisible({ timeout: 20000 })
  await expect(B.page.getByText(/Only share with someone you trust/).first()).toBeVisible()
  await B.page.getByRole('button', { name: 'Receive and share mine' }).click()
  const back = B.page.getByRole('dialog', { name: 'Share yours back with Ada' })
  await back.getByLabel('Instagram').first().check()
  await back.getByRole('textbox', { name: 'Instagram' }).fill('bea.b')
  await back.getByRole('button', { name: 'Accept and share' }).click()

  // Both cards arrive; Ada's went from her device once Bea accepted.
  await expect(B.page.getByText("Ada's contact card")).toBeVisible({ timeout: 20000 })
  await expect(B.page.getByText('+15125550134')).toBeVisible()
  await expect(A.page.getByText("Bea's contact card")).toBeVisible({ timeout: 20000 })
  await expect(A.page.getByText('@bea.b')).toBeVisible()
  const stored = (await db.collection(`matches/${id}/messages`).where('messageType', '==', 'contact_card').get()).docs.map((d) => d.data())
  expect(stored).toHaveLength(2)
  for (const m of stored) expect(m.ciphertext).not.toMatch(/5125550134|bea\.b/)

  // Bea takes them back: hidden on both devices, with the honest note.
  await B.page.getByRole('button', { name: 'Take back contact details' }).first().click()
  await expect(A.page.getByText(/took back the contact details/)).toBeVisible({ timeout: 20000 })
  await expect(A.page.getByText('@bea.b')).toHaveCount(0)
  await expect(B.page.getByText('+15125550134')).toHaveCount(0)
  await expect(B.page.getByText(/You may have saved it already/).first()).toBeVisible()
  for (const d of [A, B]) {
    expect(d.net.errors).toEqual([])
    await d.ctx.close()
  }
})

test('chat: contact details that slip through are masked on the recipient\'s device', async ({ browser }) => {
  const a = await seedUser('Ann')
  const bot = 'zbot-e2e-mask'
  const id = sortedPair(a.uid, bot)
  await db.doc(`users/${bot}`).set({ uid: bot, displayName: 'Ivy', isBot: true, age: 28, photoURLs: [], publicKey: 'seed-stub-key' })
  await db.doc(`matches/${id}`).set({ matchId: id, users: [a.uid, bot].sort(), participants: [a.uid, bot].sort(), isBot: true, mode: 'spark', matchedAt: Timestamp.now(), createdAt: Timestamp.now(), matchGeneration: Date.now() - 1000, safetyCardShown: true, participantSnapshots: { [bot]: { displayName: 'Ivy', age: 28 } } })
  await db.collection(`matches/${id}/messages`).add({ senderId: bot, messageType: 'text', ciphertext: 'text me at 512-555-0134 or @ivy.rose', nonce: 'stub', status: 'sent', sentAt: new Date(), isBot: true })
  const { ctx, page } = await device(browser, a)
  await page.goto(`/chat/${id}`)
  await expect(page.getByText('text me at ••• or •••')).toBeVisible({ timeout: 20000 })
  await expect(page.getByText(/512-555-0134|ivy\.rose/)).toHaveCount(0)
  await expect(page.getByText(/Contact details are hidden in chat/)).toBeVisible()
  await ctx.close()
})
