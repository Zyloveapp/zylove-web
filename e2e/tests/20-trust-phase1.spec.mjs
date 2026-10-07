// Trust & Safety Phase 1 (2026-10): E2E-only chat between people, photo
// consent enforced, reported chats kept for the reporter, the admin audit
// log, account age, behaviour/device signals, the risk score and the trust
// dashboard.
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, adminAuth, fnLib, sortedPair, PROJECT, setPlan,
  signIn, offline, quietFirstRun, CONTEXT, internalDoc, userDoc, FieldValue, Timestamp,
} from './helpers.mjs'

test.beforeEach(resetEmulators)

const DOCS = `projects/${PROJECT}/databases/(default)/documents`
const BASE = `http://127.0.0.1:8390/v1/${DOCS}`
const BUCKET = 'demo-zylove.appspot.com'
const headers = async (uid) => ({ Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' })
const value = (v) =>
  v === null ? { nullValue: null }
  : typeof v === 'string' ? { stringValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'boolean' ? { booleanValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(value) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } }
const fields = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, value(v)]))

// A message as the user, rules applied, with sentAt = request time (as the app sends it).
async function sendAs(uid, matchId, data, id = `m${Math.random().toString(36).slice(2)}`) {
  const r = await fetch(`${BASE}:commit`, {
    method: 'POST',
    headers: await headers(uid),
    body: JSON.stringify({
      writes: [{
        update: { name: `${DOCS}/matches/${matchId}/messages/${id}`, fields: fields({ senderId: uid, status: 'sent', ...data }) },
        currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'sentAt', setToServerValue: 'REQUEST_TIME' }],
      }],
    }),
  })
  return r.status
}
const restGet = async (uid, path) => (await fetch(`${BASE}/${path}`, { headers: await headers(uid) })).status
const restPatch = async (uid, path, data) =>
  (await fetch(`${BASE}/${path}?${Object.keys(data).map((k) => `updateMask.fieldPaths=${k}`).join('&')}`, { method: 'PATCH', headers: await headers(uid), body: JSON.stringify({ fields: fields(data) }) })).status

const JPEG = (await import('node:fs')).readFileSync(new URL('../fixture.jpg', import.meta.url))
async function storageUpload(uid, path, bytes, contentType) {
  const boundary = 'b' + Math.random().toString(36).slice(2)
  const meta = JSON.stringify({ name: path, contentType })
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  return (await fetch(`http://127.0.0.1:9909/v0/b/${BUCKET}/o?name=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { Authorization: `Firebase ${await idTokenFor(uid)}`, 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })).status
}

const woman = (name, o = {}) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o })
async function matchOf(a, b) {
  await likeAs(a.uid, b.uid)
  const r = await likeAs(b.uid, a.uid)
  expect(r.matched).toBe(true)
  return sortedPair(a.uid, b.uid)
}
// A message written with admin rights (the triggers see it as the app's).
const adminMessage = (matchId, senderId, extra = {}) =>
  db.collection(`matches/${matchId}/messages`).add({ senderId, messageType: 'text', ciphertext: 'x', nonce: 'n', status: 'sent', sentAt: new Date(), ...extra })
const signals = async (uid) => (await db.doc(`behaviorSignals/${uid}`).get()).data() ?? {}
const lastAudit = async (action) => {
  const s = await db.collection('adminAudit').where('action', '==', action).get()
  return s.docs.map((d) => d.data())
}

// ─── Prerequisite fixes ──────────────────────────────────────────────────────

test('rules: plaintext only to a curated profile; encrypted between people; hash field format', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await matchOf(a, b)
  expect(await sendAs(a.uid, id, { messageType: 'text', ciphertext: 'hello in the clear', nonce: 'stub' })).toBe(403)
  expect(await sendAs(a.uid, id, { messageType: 'text', ciphertext: 'aGVsbG8=', nonce: 'bm9uY2U=' })).toBe(200)
  expect(await sendAs(a.uid, id, { messageType: 'text', ciphertext: 'aGVsbG8=', nonce: 'bm9uY2U=', fh: 'a'.repeat(64) })).toBe(200)
  expect(await sendAs(a.uid, id, { messageType: 'text', ciphertext: 'aGVsbG8=', nonce: 'bm9uY2U=', fh: 'not-a-hash' })).toBe(403)
  // A curated profile has no keys: plaintext is how the app talks to it.
  const botId = sortedPair(a.uid, 'zbot-w-001')
  await db.doc(`matches/${botId}`).set({ users: [a.uid, 'zbot-w-001'].sort(), mode: 'spark', isBot: true, matchedAt: new Date(), matchGeneration: Date.now() })
  expect(await sendAs(a.uid, botId, { messageType: 'text', ciphertext: 'hi bot', nonce: 'stub' })).toBe(200)
})

test('rules + storage: a chat photo needs accepted photo consent', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  await setPlan(a.uid, 'spark_plus')
  const id = await matchOf(a, b)
  const path = `chat-photos/${id}/${a.uid}_1.bin`
  const photo = { messageType: 'photo', encrypted: true, storageRef: path, photoNonce: 'n', encryptedKeyForSender: 'k', encryptedKeyForRecipient: 'k', keyNonceForSender: 'n', keyNonceForRecipient: 'n', timerSeconds: 0, firstViewedAt: null, photoExpiresAt: null, destructedAt: null }
  expect(await storageUpload(a.uid, path, JPEG, 'image/x-zylove-encrypted')).toBe(403)
  expect(await sendAs(a.uid, id, photo)).toBe(403)
  await db.doc(`matches/${id}`).update({ photoConsent: { status: 'accepted', requestedBy: a.uid } })
  expect(await storageUpload(a.uid, path, JPEG, 'image/x-zylove-encrypted')).toBe(200)
  expect(await sendAs(a.uid, id, photo)).toBe(200)
})

test('unmatch: a reported chat is kept for the reporter (read-only), gone for the other person, then purged', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await matchOf(a, b)
  const msg = await adminMessage(id, b.uid)
  // The match's generation as the app derives it: matchGeneration, else the
  // earliest of matchedAt/createdAt (matchGeneration is stamped a moment later).
  const md = (await db.doc(`matches/${id}`).get()).data()
  const generation = md.matchGeneration ?? Math.min(...[md.matchedAt, md.createdAt].filter(Boolean).map((t) => t.toMillis()))
  await callAs(a.uid, 'submitReport', { matchId: id, reportedUid: b.uid, categories: ['inappropriate'], generation })
  await callAs(b.uid, 'unmatchConnection', { matchId: id })
  const m = (await db.doc(`matches/${id}`).get()).data()
  expect(m.users).toEqual([a.uid])
  expect([...m.pairUsers].sort()).toEqual([a.uid, b.uid].sort())
  expect(m.preservedFor).toEqual([a.uid])
  expect(await restGet(a.uid, `matches/${id}/messages/${msg.id}`)).toBe(200)
  expect(await restGet(b.uid, `matches/${id}/messages/${msg.id}`)).toBe(403)
  expect(await sendAs(a.uid, id, { messageType: 'text', ciphertext: 'aGk=', nonce: 'bg==' })).toBe(403) // read-only
  // No re-match over it while it's kept.
  expect((await likeAs(a.uid, b.uid)).matched).toBe(false)
  expect((await db.doc(`matches/${id}`).get()).data().preservedFor).toEqual([a.uid])
  // After 30 days it goes, with its messages.
  await db.doc(`matches/${id}`).update({ preservedUntil: Timestamp.fromMillis(Date.now() - 1000) })
  await fnLib('behavior').purgePreservedChats.run({})
  await expect.poll(async () => (await db.doc(`matches/${id}`).get()).exists, { timeout: 15000 }).toBe(false)
  await expect.poll(async () => (await db.doc(`matches/${id}/messages/${msg.id}`).get()).exists, { timeout: 15000 }).toBe(false)
})

test('unmatch without a report still deletes the chat at once', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await matchOf(a, b)
  await adminMessage(id, a.uid)
  await callAs(a.uid, 'unmatchConnection', { matchId: id })
  expect((await db.doc(`matches/${id}`).get()).exists).toBe(false)
})

test('unmatch offers "Report first" in the chat menu', async ({ browser }) => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await matchOf(a, b)
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, a.uid)
  await page.addInitScript((m) => localStorage.setItem(`zylove_chat_seen_${m}`, '1'), id)
  await signIn(page, a.phone, { expectPath: /\/discover/ })
  await page.goto(`/chat/${id}`)
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('button', { name: 'Unmatch' }).click()
  await expect(page.getByText(/Report first — a reported chat stays readable to you for 30 days/)).toBeVisible()
  await page.getByRole('button', { name: 'Report first' }).click()
  await expect(page.getByText(/report/i).first()).toBeVisible()
  await ctx.close()
})

// ─── Admin audit log ─────────────────────────────────────────────────────────

test('audit: every admin view and action is logged; non-admins are refused', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Ann')
  await expect(callAs(a.uid, 'adminGetReports', {})).rejects.toThrow(/Admins only/)
  await expect(callAs(a.uid, 'adminTrustQueue', {})).rejects.toThrow(/Admins only/)
  await callAs(admin.uid, 'adminGetReports', {})
  await callAs(admin.uid, 'adminTrustQueue', { status: 'open' })
  await callAs(admin.uid, 'adminTrustDetail', { uid: a.uid })
  await callAs(admin.uid, 'adminViewProfile', { uid: a.uid })
  for (const action of ['reports.list', 'trust.queue', 'trust.detail', 'profile.view']) {
    const rows = await lastAudit(action)
    expect(rows.length, action).toBeGreaterThan(0)
    expect(rows[0].actor).toBe(admin.uid)
    expect(rows[0].expiresAt).toBeTruthy()
  }
  expect((await lastAudit('trust.detail'))[0].target).toBe(a.uid)
  // An action needs a reason, and the reason is logged.
  await expect(callAs(admin.uid, 'adminTrustAction', { uid: a.uid, action: 'reduce_visibility', reason: '' })).rejects.toThrow(/reason/)
  await callAs(admin.uid, 'adminTrustAction', { uid: a.uid, action: 'reduce_visibility', reason: 'Copy-paste openers to many people' })
  const act = (await lastAudit('trust.reduce_visibility'))[0]
  expect(act).toMatchObject({ actor: admin.uid, target: a.uid, reason: 'Copy-paste openers to many people' })
  // Clients can't read or write the log.
  expect(await restGet(admin.uid, 'adminAudit')).not.toBe(200)
})

// ─── Account age ─────────────────────────────────────────────────────────────

test('account age comes from Auth; "member since" is server-written only', async () => {
  const a = await seedUser('Ann', { createdAt: Date.UTC(2015, 0, 1) }) // a client-written createdAt isn't trusted
  await callAs(a.uid, 'initUserDefaults', {})
  const created = Date.parse((await adminAuth.getUser(a.uid)).metadata.creationTime)
  expect((await internalDoc(a.uid)).accountCreatedAt).toBe(created)
  expect((await userDoc(a.uid)).memberSince).toMatch(/^\d{4}-\d{2}$/)
  expect((await userDoc(a.uid)).memberSince).not.toBe('2015-01')
  expect(await restPatch(a.uid, `users/${a.uid}`, { memberSince: '2015-01' })).toBe(403)
})

// ─── Signals ─────────────────────────────────────────────────────────────────

test('signals: "maybe" is recorded but keeps the card; replies counted both ways', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  await callAs(a.uid, 'recordSwipe', { targetUid: b.uid, action: 'maybe', mode: 'spark' })
  const swipes = await db.collection('swipes').where('swiperId', '==', a.uid).get()
  expect(swipes.docs.map((d) => d.data().action)).toEqual(['maybe'])
  expect(((await db.doc(`exploreState/${a.uid}`).get()).data()?.spark?.acted ?? [])).not.toContain(b.uid)
  const id = await matchOf(a, b)
  await adminMessage(id, a.uid)
  await expect.poll(async () => (await signals(a.uid)).conversationsStarted ?? 0, { timeout: 15000 }).toBe(1)
  await adminMessage(id, b.uid)
  await expect.poll(async () => (await signals(b.uid)).repliesGiven ?? 0, { timeout: 15000 }).toBe(1)
  expect((await signals(b.uid)).conversationsReceived).toBe(1)
  expect((await signals(a.uid)).repliesReceived).toBe(1)
  expect((await signals(a.uid)).messagesSent).toBe(1)
})

test('signals: the same opener to 5 people is noted; to 10 it flags the sender; the hash leaves the message', async () => {
  test.setTimeout(180000)
  const a = await seedUser('Ann')
  const fh = createHash('sha256').update('same opener every time').digest('hex')
  let first
  for (let i = 0; i < 10; i++) {
    const w = await woman(`W${i}`)
    const id = await matchOf(a, w)
    const ref = await adminMessage(id, a.uid, { fh })
    first ??= ref
    if (i === 4) {
      // Five alike is common enough ("hey, how's your week going?"): noted, not flagged.
      await expect.poll(async () => (await signals(a.uid)).duplicateOpener?.recipients24h ?? 0, { timeout: 20000 }).toBe(5)
      await new Promise((r) => setTimeout(r, 2000))
      expect((await db.doc(`trustFlags/${a.uid}`).get()).exists).toBe(false)
    }
  }
  await expect.poll(async () => (await signals(a.uid)).duplicateOpener?.recipients24h ?? 0, { timeout: 20000 }).toBe(10)
  await expect.poll(async () => (await first.get()).data().fh, { timeout: 15000 }).toBeUndefined()
  // A strong signal rescored at once: an open flag with the reason.
  await expect.poll(async () => (await db.doc(`trustFlags/${a.uid}`).get()).data()?.status, { timeout: 20000 }).toBe('open')
  const flag = (await db.doc(`trustFlags/${a.uid}`).get()).data()
  expect(flag.reasons.map((r) => r.key)).toContain('duplicate_opener')
})

test('signals: hitting the daily like cap is recorded', async () => {
  const a = await seedUser('Ann')
  await setPlan(a.uid, 'free')
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  await db.doc(`usage/${a.uid}`).set({ likes: { [`d:${today}`]: 10, life: 10 } })
  const b = await woman('Bea')
  await expect(callAs(a.uid, 'onLike', { likedUserId: b.uid, mode: 'spark' })).rejects.toThrow()
  await expect.poll(async () => (await signals(a.uid)).capHitDays ?? [], { timeout: 10000 }).toContain(today)
})

// ─── Devices ─────────────────────────────────────────────────────────────────

test('devices: one device on two accounts links them; a banned account\'s device flags the next one', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Ann')
  const b = await seedUser('Abe')
  const device = 'dev_' + 'x'.repeat(20)
  await callAs(a.uid, 'recordDevice', { deviceId: device })
  await callAs(b.uid, 'recordDevice', { deviceId: device })
  const linked = await fnLib('devices').linkedAccounts(a.uid)
  expect(linked.map((l) => l.uid)).toContain(b.uid)
  expect(linked.find((l) => l.uid === b.uid).via).toContain('device')
  // Nothing in the clear.
  const mine = (await db.doc(`userDevices/${a.uid}`).get()).data()
  expect(JSON.stringify(mine)).not.toContain(device)
  // Ban Ann; Cal shows up on her device → flagged, not banned.
  await callAs(admin.uid, 'adminModerate', { uid: a.uid, action: 'ban' })
  const c = await seedUser('Cal')
  await callAs(c.uid, 'recordDevice', { deviceId: device })
  await expect.poll(async () => Boolean((await signals(c.uid)).bannedDeviceMatch), { timeout: 15000 }).toBe(true)
  await expect.poll(async () => (await db.doc(`trustFlags/${c.uid}`).get()).data()?.status, { timeout: 20000 }).toBe('open')
  expect((await db.doc(`trustFlags/${c.uid}`).get()).data().reasons[0].key).toBe('banned_device')
  expect((await internalDoc(c.uid)).isSuspended).not.toBe(true) // flag → review, never automatic
})

test('devices: deleting an account removes its device data', async () => {
  const a = await seedUser('Ann')
  await callAs(a.uid, 'recordDevice', { deviceId: 'dev_' + 'y'.repeat(20) })
  expect((await db.doc(`userDevices/${a.uid}`).get()).exists).toBe(true)
  await fnLib('userData').clearPrivateData(a.uid)
  expect((await db.doc(`userDevices/${a.uid}`).get()).exists).toBe(false)
})

// ─── Score, directory, actions ───────────────────────────────────────────────

test('nightly score: ordinary accounts aren\'t flagged; profiles and the name index are written', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  await matchOf(a, b)
  await fnLib('trustScore').computeTrustScores.run({})
  const p = (await db.doc(`trustProfiles/${a.uid}`).get()).data()
  expect(p.score).toBe(0)
  expect(p.cohort).toBe('men|spark')
  expect((await db.doc(`trustFlags/${a.uid}`).get()).exists).toBe(false)
  expect((await internalDoc(a.uid)).searchName).toBe('ann')
})

test('directory: by name, user id and phone; flagged accounts first; queries not logged', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Sam')
  const b = await seedUser('Samir')
  await fnLib('trustScore').computeTrustScores.run({})
  await db.doc(`trustFlags/${b.uid}`).set({ uid: b.uid, status: 'open', score: 55, reasons: [{ key: 'x', points: 55, text: 'test' }] })
  const byName = (await callAs(admin.uid, 'adminSearchUsers', { q: 'sam' })).results
  expect(byName.map((r) => r.uid)).toEqual([b.uid, a.uid])
  expect((await callAs(admin.uid, 'adminSearchUsers', { q: a.uid })).results.map((r) => r.uid)).toEqual([a.uid])
  expect((await callAs(admin.uid, 'adminSearchUsers', { q: a.phone })).results.map((r) => r.uid)).toEqual([a.uid])
  const logged = await lastAudit('directory.search')
  expect(logged.length).toBe(3)
  expect(JSON.stringify(logged)).not.toContain(a.phone)
  expect(JSON.stringify(logged)).not.toContain('sam')
})

test('actions: reduce visibility reaches Explore; suspend locks the account and closes the flag', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Ann')
  await db.doc(`trustFlags/${a.uid}`).set({ uid: a.uid, status: 'open', score: 60, reasons: [] })
  await callAs(admin.uid, 'adminTrustAction', { uid: a.uid, action: 'reduce_visibility', reason: 'Linked to a banned account' })
  await expect.poll(async () => (await db.doc(`exploreIndex/${a.uid}`).get()).data()?.reduced, { timeout: 10000 }).toBe(true)
  await callAs(admin.uid, 'adminTrustAction', { uid: a.uid, action: 'suspend', reason: 'Scam pattern confirmed', days: 30 })
  expect((await internalDoc(a.uid))).toMatchObject({ isSuspended: true, suspendSource: 'trust' })
  expect((await adminAuth.getUser(a.uid)).disabled).toBe(true)
  expect((await db.doc(`trustFlags/${a.uid}`).get()).data()).toMatchObject({ status: 'actioned', closeReason: expect.stringMatching(/Linked|Scam/) })
})

test('dashboard: an admin sees why an account was flagged and dismisses it with a reason', async ({ browser }) => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Rex')
  await db.doc(`trustFlags/${a.uid}`).set({ uid: a.uid, status: 'open', score: 70, reasons: [{ key: 'banned_device', points: 60, text: 'Uses a device that a banned account used' }], openedAt: new Date() })
  await db.doc(`trustProfiles/${a.uid}`).set({ score: 70, reasons: [{ key: 'banned_device', points: 60, text: 'Uses a device that a banned account used' }], features: { swipes7d: 3 }, cohort: 'men|spark', computedAt: new Date() })
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, admin.uid)
  await signIn(page, admin.phone, { expectPath: /\/discover/ })
  await page.goto('/admin/trust')
  await page.getByRole('button', { name: /Rex/ }).click()
  await expect(page.getByText('Uses a device that a banned account used')).toBeVisible()
  await page.getByRole('button', { name: 'Dismiss flag' }).click()
  await page.getByPlaceholder(/Why/).fill('Shared family tablet, confirmed')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(async () => (await db.doc(`trustFlags/${a.uid}`).get()).data()?.status, { timeout: 10000 }).toBe('dismissed')
  expect((await lastAudit('trust.dismiss'))[0].reason).toBe('Shared family tablet, confirmed')
  await ctx.close()
})
