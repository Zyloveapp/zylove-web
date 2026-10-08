// Trust & Safety Phase 4 (2026-10): message franking, evidence capture (only
// the selected messages leave the device), the encrypted locker (retention,
// legal hold, every view logged), the reporter PDF, and appeals.
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  resetEmulators, seedUser, callAs, likeAs, db, adminAuth, fnLib, sortedPair, signIn, offline, quietFirstRun, CONTEXT, userDoc, internalDoc, Timestamp, APP, smsCode,
  idTokenFor, PROJECT, setPlan,
} from './helpers.mjs'

test.beforeEach(resetEmulators)

// The same TEST-ONLY keys run.sh gives the functions emulator.
const testKey = (s) => createHash('sha256').update(s).digest('hex')
const FRANK = [{ v: 'v1', key: testKey('e2e-franking-key') }]
const LOCKER = [{ v: 'v1', key: testKey('e2e-locker-key') }]
const BUCKET = 'demo-zylove.appspot.com'
const DAY = 864e5

const woman = (name, o = {}) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o })
async function matchOf(a, b) {
  await likeAs(a.uid, b.uid)
  expect((await likeAs(b.uid, a.uid)).matched).toBe(true)
  return sortedPair(a.uid, b.uid)
}
async function lockerItems(id) {
  const d = (await db.doc(`evidenceLocker/${id}`).get()).data()
  const { getStorage } = await import('firebase-admin/storage')
  const [raw] = await getStorage().bucket(BUCKET).file(d.file).download()
  return fnLib('lockerCore').open(LOCKER, { ...JSON.parse(raw.toString('utf8')), v: d.v }).items
}
const audits = async (action) => (await db.collection('adminAudit').where('action', '==', action).get()).docs.map((x) => x.data())

// A franked message written as the server would see it from the app.
async function franked(matchId, sender, text, seq, { photo = null } = {}) {
  const core = fnLib('frankingCore')
  const kf = createHash('sha256').update(`kf-${matchId}-${seq}-${text}`).digest('hex')
  const cid = `cid${seq}abcdefgh`
  const plaintext = photo ? core.photoPlaintext(photo) : text
  const fc = core.commitment(kf, plaintext, { cid, matchId, sender, seq })
  const ref = await db.collection(`matches/${matchId}/messages`).add({
    senderId: sender, messageType: photo ? 'photo' : 'text', ciphertext: 'sealed', nonce: 'bm9uY2U=', status: 'sent', sentAt: new Date(), fc, fk: 'x', fkn: 'y', cid, seq,
  })
  await expect.poll(async () => (await db.doc(`franking/${matchId}_${ref.id}`).get()).exists, { timeout: 30000 }).toBe(true)
  return { id: ref.id, kf, text }
}

// ─── Franking from the app ───────────────────────────────────────────────────

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

test('franking + evidence on the devices: commitments and server tags; a tampered message is refused; only the picked messages leave; reporter PDF', async ({ browser }) => {
  const a = await seedUser('Ada')
  const b = await woman('Bea')
  const id = await seedMatch(a, b)
  const A = await device(browser, a)
  const B = await device(browser, b)
  for (const u of [a, b]) await expect.poll(async () => (await userDoc(u.uid)).publicKey?.length ?? 0, { timeout: 20000 }).toBeGreaterThan(20)
  await B.page.goto(`/chat/${id}`)
  for (const t of ['hey Ada', 'can you send me money through cash app', 'its urgent please']) await send(B.page, 'Ada', t)
  await expect.poll(async () => (await db.collection(`matches/${id}/messages`).get()).size, { timeout: 20000 }).toBe(3)

  // Each message: commitment, encrypted key, client id, sequence; the server tagged it.
  const msgs = (await db.collection(`matches/${id}/messages`).orderBy('sentAt').get()).docs
  expect(msgs.map((d) => d.data().seq)).toEqual([1, 2, 3])
  for (const d of msgs) {
    expect(d.data()).toMatchObject({ fc: expect.stringMatching(/^[a-f0-9]{64}$/), fk: expect.any(String), cid: expect.any(String) })
    expect(d.data().fk).not.toMatch(/^[a-f0-9]{64}$/) // the key travels encrypted
    await expect.poll(async () => (await db.doc(`franking/${id}_${d.id}`).get()).data()?.sender, { timeout: 30000 }).toBe(b.uid)
  }

  // Ada reports with 2 of the 3 messages; the network carries only those.
  await A.page.goto(`/chat/${id}`)
  await expect(A.page.getByText('its urgent please')).toBeVisible({ timeout: 20000 })
  const bodies = []
  A.page.on('request', (r) => { if (r.url().includes('submitEvidence')) bodies.push(r.postData() ?? '') })
  await A.page.getByRole('button', { name: 'More options' }).click()
  await A.page.getByRole('button', { name: 'Report Bea' }).click()
  await A.page.getByRole('button', { name: /Scam or asked for money/ }).click()
  await A.page.getByRole('button', { name: 'Add evidence (choose messages)' }).click()
  await A.page.getByRole('checkbox', { name: 'Bea: can you send me money through cash app' }).check()
  await A.page.getByRole('checkbox', { name: 'Bea: its urgent please' }).check()
  await A.page.getByRole('button', { name: /^Review/ }).click()
  await expect(A.page.getByText("Only the messages you selected will be sent to the Zylove safety team, unencrypted, so a person can review your report. Nothing else from this chat leaves your device, and the person you're reporting won't be told.", { exact: true })).toBeVisible()
  await A.page.getByRole('button', { name: 'Send report with 2 messages' }).click()
  await expect(A.page.getByText(/Report sent/)).toBeVisible({ timeout: 20000 })
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toContain('cash app')
  expect(bodies[0]).not.toContain('hey Ada')

  const lockers = (await db.collection('evidenceLocker').get()).docs
  expect(lockers).toHaveLength(1)
  expect(lockers[0].data()).toMatchObject({ reporterUid: a.uid, reportedUid: b.uid, categories: ['scam'], summary: { items: 2, verified: 2, mismatch: 0 } })
  const items = await lockerItems(lockers[0].id)
  expect(items.map((x) => x.text)).toEqual(['can you send me money through cash app', 'its urgent please'])
  expect(items.every((x) => x.verdict === 'verified' && x.from === 'reported')).toBe(true)
  // Sealed at rest.
  const { getStorage } = await import('firebase-admin/storage')
  const [raw] = await getStorage().bucket(BUCKET).file(lockers[0].data().file).download()
  expect(raw.toString('utf8')).not.toContain('cash app')
  // Bea is never told.
  expect((await db.collection(`matches/${id}/messages`).get()).size).toBe(3)
  expect((await db.doc(`users/${b.uid}/private/account`).get()).data()?.adminNotice).toBeUndefined()

  // Ada's own copy: a PDF, made on demand, not stored.
  const download = A.page.waitForEvent('download')
  await A.page.getByRole('button', { name: 'Download your copy (PDF)' }).click()
  const pdf = await (await download).createReadStream()
  const chunks = []
  for await (const c of pdf) chunks.push(c)
  expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe('%PDF-')
  const [files] = await getStorage().bucket(BUCKET).getFiles({ prefix: 'evidence/' })
  expect(files).toHaveLength(1) // only the sealed evidence — no stored PDF

  // A message whose commitment doesn't match is refused on the device.
  await db.doc(`matches/${id}/messages/${msgs[0].id}`).update({ fc: 'f'.repeat(64) })
  await expect(A.page.getByText("This message couldn't be verified, so it isn't shown.")).toBeVisible({ timeout: 20000 })
  await expect(A.page.getByText('hey Ada')).toHaveCount(0)
  for (const d of [A, B]) {
    expect(d.net.errors).toEqual([])
    await d.ctx.close()
  }
})

// ─── Verification on the server ──────────────────────────────────────────────

test('evidence: tampered or misattributed messages and wrong photo bytes fail; older messages are "unverified"; needs a report; other chats refused', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const c = await woman('Cat')
  const id = await matchOf(a, b)
  const genuine = await franked(id, b.uid, 'meet me alone tonight', 1)
  const mine = await franked(id, a.uid, 'no thanks', 1)
  const photoBytes = Buffer.from('fake-jpeg-bytes-for-the-test')
  const pic = await franked(id, b.uid, '', 2, { photo: photoBytes })
  const old = await db.collection(`matches/${id}/messages`).add({ senderId: b.uid, messageType: 'text', ciphertext: 'sealed', nonce: 'n', status: 'sent', sentAt: new Date() })
  const ev = (items) => callAs(a.uid, 'submitEvidence', { matchId: id, reportedUid: b.uid, items })

  await expect(ev([{ msgId: genuine.id, plaintext: genuine.text, kf: genuine.kf }])).rejects.toThrow(/Send the report first/)
  await callAs(a.uid, 'submitReport', { matchId: id, reportedUid: b.uid, categories: ['felt_unsafe'] })
  const r = await ev([
    { msgId: genuine.id, plaintext: genuine.text, kf: genuine.kf }, // verified
    { msgId: mine.id, plaintext: 'no thanks', kf: mine.kf }, // verified, from the reporter
    { msgId: pic.id, photo: photoBytes.toString('base64'), kf: pic.kf }, // photo bound to its bytes
    { msgId: old.id, plaintext: 'whatever they claim', kf: null }, // before franking
  ])
  expect(r.summary).toMatchObject({ items: 4, verified: 3, unverified: 1, mismatch: 0, photos: 1 })
  const items = await lockerItems(r.lockerId)
  expect(items.map((x) => [x.from, x.verdict])).toEqual([['reported', 'verified'], ['reporter', 'verified'], ['reported', 'verified'], ['reported', 'unverified']])

  const bad = await ev([
    { msgId: genuine.id, plaintext: 'meet me alone tonight or else', kf: genuine.kf }, // edited
    { msgId: pic.id, photo: Buffer.from('a-different-photo').toString('base64'), kf: pic.kf }, // other bytes
    { msgId: mine.id, plaintext: 'no thanks', kf: genuine.kf }, // someone else's key
  ])
  expect(bad.summary).toMatchObject({ verified: 0, mismatch: 3 })
  // Claiming a message is from them doesn't change who sent it.
  const misattributed = await lockerItems((await ev([{ msgId: mine.id, plaintext: 'no thanks', kf: mine.kf, from: 'reported' }])).lockerId)
  expect(misattributed[0].from).toBe('reporter')

  // Another chat's messages can't be pulled in.
  const other = await matchOf(a, c)
  const theirs = await franked(other, c.uid, 'hi Ann', 1)
  await expect(ev([{ msgId: theirs.id, plaintext: 'hi Ann', kf: theirs.kf }])).resolves.toMatchObject({ summary: { unverified: 1 } }) // not on record here
  await expect(callAs(c.uid, 'submitEvidence', { matchId: id, reportedUid: b.uid, items: [{ msgId: genuine.id, plaintext: 'x' }] })).rejects.toThrow(/Send the report first|Not your conversation/)
})

// ─── The locker ──────────────────────────────────────────────────────────────

test('locker: list, filter and detail are admin-only and logged; decisions start retention (30 days, NCMEC 1 year); holds stop deletion; purge removes expired items and files', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await matchOf(a, b)
  const m = await franked(id, b.uid, 'send nudes or else', 1)
  await callAs(a.uid, 'submitReport', { matchId: id, reportedUid: b.uid, categories: ['felt_unsafe'] })
  const one = (await callAs(a.uid, 'submitEvidence', { matchId: id, reportedUid: b.uid, items: [{ msgId: m.id, plaintext: m.text, kf: m.kf }] })).lockerId
  const two = (await callAs(a.uid, 'submitEvidence', { matchId: id, reportedUid: b.uid, items: [{ msgId: m.id, plaintext: m.text, kf: m.kf }] })).lockerId
  const three = (await callAs(a.uid, 'submitEvidence', { matchId: id, reportedUid: b.uid, items: [{ msgId: m.id, plaintext: m.text, kf: m.kf }] })).lockerId

  await expect(callAs(a.uid, 'adminLockerList', {})).rejects.toThrow(/Admins only/)
  await expect(callAs(a.uid, 'adminLockerDetail', { id: one })).rejects.toThrow(/Admins only/)
  expect((await callAs(admin.uid, 'adminLockerList', { status: 'open', category: 'felt_unsafe' })).items).toHaveLength(3)
  expect((await callAs(admin.uid, 'adminLockerList', { status: 'open', category: 'scam' })).items).toHaveLength(0)
  const detail = await callAs(admin.uid, 'adminLockerDetail', { id: one })
  expect(detail.items[0]).toMatchObject({ text: 'send nudes or else', verdict: 'verified' })
  expect(await audits('locker.list')).toHaveLength(2)
  expect((await audits('locker.view'))[0]).toMatchObject({ actor: admin.uid, target: b.uid, detail: { id: one } })

  const before = Date.now()
  await expect(callAs(admin.uid, 'adminLockerDecide', { id: one, decision: 'actioned' })).rejects.toThrow(/reason/)
  await callAs(admin.uid, 'adminLockerDecide', { id: one, decision: 'actioned', reason: 'Threat confirmed' })
  await callAs(admin.uid, 'adminLockerDecide', { id: two, decision: 'actioned', ncmec: true, reason: 'Child-safety case' })
  const exp = async (x) => (await db.doc(`evidenceLocker/${x}`).get()).data().expiresAt.toMillis()
  expect(await exp(one)).toBeGreaterThanOrEqual(before + 30 * DAY)
  expect(await exp(one)).toBeLessThan(before + 31 * DAY)
  expect(await exp(two)).toBeGreaterThanOrEqual(before + 365 * DAY)
  const outcome = (await db.doc(`evidenceOutcomes/${one}`).get()).data()
  expect(outcome).toMatchObject({ decision: 'actioned', reportedUid: b.uid, reporterUid: a.uid, categories: ['felt_unsafe'] })
  expect(JSON.stringify(outcome)).not.toContain('nudes') // no content
  expect(outcome.expiresAt.toMillis()).toBeGreaterThan(before + 2 * 364 * DAY)

  // Legal hold: who, when, why — and it survives the purge.
  await callAs(admin.uid, 'adminLockerHold', { id: three, hold: true, kind: 'law_enforcement', reason: 'Preservation request #123' })
  expect((await db.doc(`evidenceLocker/${three}`).get()).data().legalHold).toMatchObject({ kind: 'law_enforcement', by: admin.uid, reason: 'Preservation request #123' })
  for (const x of [one, three]) await db.doc(`evidenceLocker/${x}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) })
  const fileOf = async (x) => (await db.doc(`evidenceLocker/${x}`).get()).data().file
  const oneFile = await fileOf(one)
  await fnLib('evidence').purgeEvidence.run({})
  expect((await db.doc(`evidenceLocker/${one}`).get()).exists).toBe(false)
  const { getStorage } = await import('firebase-admin/storage')
  expect((await getStorage().bucket(BUCKET).file(oneFile).exists())[0]).toBe(false)
  expect((await db.doc(`evidenceLocker/${three}`).get()).exists).toBe(true) // held
  expect((await db.doc(`evidenceLocker/${two}`).get()).exists).toBe(true) // not due
  expect((await db.doc(`evidenceOutcomes/${one}`).get()).exists).toBe(true) // the record stays
  await callAs(admin.uid, 'adminLockerHold', { id: three, hold: false, reason: 'Request closed' })
  await fnLib('evidence').purgeEvidence.run({})
  expect((await db.doc(`evidenceLocker/${three}`).get()).exists).toBe(false)
  expect((await audits('locker.hold'))).toHaveLength(1)
  expect((await audits('locker.release'))).toHaveLength(1)

  // The reports dashboard's decision decides that account's open evidence too.
  const four = (await callAs(a.uid, 'submitEvidence', { matchId: id, reportedUid: b.uid, items: [{ msgId: m.id, plaintext: m.text, kf: m.kf }] })).lockerId
  await callAs(admin.uid, 'adminModerate', { uid: b.uid, action: 'clear' })
  expect((await db.doc(`evidenceLocker/${four}`).get()).data()).toMatchObject({ status: 'decided', decision: 'no_action' })
})

// ─── Appeals ─────────────────────────────────────────────────────────────────

test('appeal: a suspended account is refused at sign-in with an appeal; one appeal; it pauses evidence retention; overturned → can sign in', async ({ browser }) => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await matchOf(a, b)
  const m = await franked(id, b.uid, 'pay me or I post your photos', 1)
  await callAs(a.uid, 'submitReport', { matchId: id, reportedUid: b.uid, categories: ['aggressive'] })
  const lockerId = (await callAs(a.uid, 'submitEvidence', { matchId: id, reportedUid: b.uid, items: [{ msgId: m.id, plaintext: m.text, kf: m.kf }] })).lockerId
  await callAs(admin.uid, 'adminModerate', { uid: b.uid, action: 'suspend', days: 30 })
  expect((await internalDoc(b.uid)).isSuspended).toBe(true)
  expect((await adminAuth.getUser(b.uid)).disabled).toBe(false)
  expect((await db.doc(`evidenceLocker/${lockerId}`).get()).data().status).toBe('decided')

  async function tryToSignIn() {
    const ctx = await browser.newContext(CONTEXT)
    const page = await ctx.newPage()
    await offline(page)
    await page.goto(`${APP}/login`)
    await page.getByLabel('Phone number (US)').fill(b.phone.slice(2))
    await page.getByRole('button', { name: 'Send code' }).click()
    await expect(page.getByText('Enter your code')).toBeVisible({ timeout: 20000 })
    let code = null
    for (let i = 0; i < 40 && !code; i++) {
      code = await smsCode(b.phone)
      if (!code) await page.waitForTimeout(250)
    }
    await page.getByPlaceholder('123456').fill(code)
    await page.getByRole('button', { name: 'Verify' }).click()
    return { ctx, page }
  }

  const first = await tryToSignIn()
  await expect(first.page.getByRole('heading', { name: 'Your account is suspended' })).toBeVisible({ timeout: 20000 })
  await expect(first.page.getByText(/suspended until/)).toBeVisible()
  const box = first.page.getByRole('textbox', { name: 'Your appeal' })
  await box.fill('x'.repeat(1200))
  expect((await box.inputValue()).length).toBe(1000) // capped
  await box.fill('I was joking with a friend I know in real life — please look again.')
  await first.page.getByRole('button', { name: 'Send appeal' }).click()
  await expect(first.page.getByText(/Your appeal is with our team/)).toBeVisible({ timeout: 20000 })
  await first.ctx.close()
  const appeals = (await db.collection('appeals').where('uid', '==', b.uid).get()).docs
  expect(appeals).toHaveLength(1)
  expect(appeals[0].data()).toMatchObject({ status: 'pending', note: expect.stringMatching(/joking/) })
  expect((await db.doc(`evidenceLocker/${lockerId}`).get()).data()).toMatchObject({ appealPending: true, expiresAt: null })

  // One appeal per suspension: the next refusal carries no token.
  expect(await fnLib('appeals').suspensionRefusal(b.uid)).toMatch(/^ZYLOVE_SUSPENDED:-:pending:/)
  const second = await tryToSignIn()
  await expect(second.page.getByText(/Your appeal is with our team/)).toBeVisible({ timeout: 20000 })
  await expect(second.page.getByRole('button', { name: 'Send appeal' })).toHaveCount(0)
  await second.ctx.close()
  await expect(callAs(b.uid, 'submitAppeal', { token: 'a'.repeat(32), note: 'trying again with a made-up token' })).rejects.toThrow(/expired/)

  // Admin overturns it, with a reason, logged.
  const list = await callAs(admin.uid, 'adminListAppeals', { status: 'pending' })
  expect(list.appeals).toHaveLength(1)
  await callAs(admin.uid, 'adminDecideAppeal', { id: list.appeals[0].id, decision: 'overturned', reason: 'Context checks out' })
  expect((await internalDoc(b.uid)).isSuspended).toBe(false)
  expect((await audits('appeal.decide'))[0]).toMatchObject({ actor: admin.uid, target: b.uid, reason: 'Context checks out' })
  const after = (await db.doc(`evidenceLocker/${lockerId}`).get()).data()
  expect(after.appealPending).toBe(false)
  expect(after.expiresAt.toMillis()).toBeGreaterThan(Date.now() + 29 * DAY)
  expect((await db.doc(`evidenceOutcomes/${lockerId}`).get()).data().appeal).toMatchObject({ outcome: 'overturned' })

  // Back in.
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, b.uid)
  await signIn(page, b.phone, { expectPath: /\/discover/ })
  await ctx.close()
})

// ─── Suspension in the rules ─────────────────────────────────────────────────

const DOCS = `projects/${PROJECT}/databases/(default)/documents`
const BASE = `http://127.0.0.1:8390/v1/${DOCS}`
const val = (v) =>
  typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)])) } }
const asFields = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, val(v)]))
async function commit(token, writes) {
  return (await fetch(`${BASE}:commit`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) })).status
}
const newDoc = (path, data, serverTime = null) => ({
  update: { name: `${DOCS}/${path}`, fields: asFields(data) },
  currentDocument: { exists: false },
  ...(serverTime ? { updateTransforms: [{ fieldPath: serverTime, setToServerValue: 'REQUEST_TIME' }] } : {}),
})
const patch = (path, data) => ({ update: { name: `${DOCS}/${path}`, fields: asFields(data) }, updateMask: { fieldPaths: Object.keys(data) } })
async function upload(token, path, contentType) {
  const boundary = 'b' + Math.random().toString(36).slice(2)
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ name: path, contentType })}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.from('fake-image-bytes'),
    Buffer.from(`\r\n--${boundary}--`),
  ])
  return (await fetch(`http://127.0.0.1:9909/v0/b/${BUCKET}/o?name=${encodeURIComponent(path)}`, {
    method: 'POST', headers: { Authorization: `Firebase ${token}`, 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).status
}

test('rules: a suspended user with a still-valid session is refused — messages, photos, likes, match and profile writes, uploads; deletion-pending and expired suspensions are not', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  await setPlan(a.uid, 'spark_plus')
  const id = await matchOf(a, b)
  await db.doc(`matches/${id}`).update({ photoConsent: { status: 'accepted', requestedBy: b.uid } })
  const token = await idTokenFor(a.uid) // minted before the suspension: still valid
  let n = 0
  const tries = async () => {
    n++
    return {
      message: await commit(token, [newDoc(`matches/${id}/messages/m${n}`, { senderId: a.uid, status: 'sent', messageType: 'text', ciphertext: 'c2VhbGVk', nonce: 'bm9uY2U=' }, 'sentAt')]),
      profile: await commit(token, [patch(`users/${a.uid}`, { bio: `bio ${n}` })]),
      like: await commit(token, [newDoc(`swipes/s${n}${a.uid}`, { swiperId: a.uid, swipedId: b.uid, action: 'like', mode: 'spark' }, 'timestamp')]),
      match: await commit(token, [patch(`matches/${id}`, { hasUnread: n % 2 === 0 })]),
      typing: await commit(token, [patch(`matches/${id}/typing/${a.uid}`, { at: n })]),
      profilePhoto: await upload(token, `photos/${a.uid}/spark/p${n}.jpg`, 'image/jpeg'),
      chatPhoto: await upload(token, `chat-photos/${id}/${a.uid}_${n}.bin`, 'image/x-zylove-encrypted'),
    }
  }
  const before = await tries()
  for (const [k, v] of Object.entries(before)) expect([k, v]).toEqual([k, 200])

  await callAs(admin.uid, 'adminModerate', { uid: a.uid, action: 'suspend', days: 30 })
  const during = await tries()
  for (const [k, v] of Object.entries(during)) expect([k, v]).toEqual([k, 403])

  // A suspension past its end date (waiting for the hourly lift) isn't enforced.
  await db.doc(`userInternal/${a.uid}`).update({ suspendedUntil: Timestamp.fromMillis(Date.now() - 1000) })
  expect((await tries()).message).toBe(200)
  // Suspended only for a pending deletion: still allowed (they may cancel it).
  await db.doc(`userInternal/${a.uid}`).update({ suspendedUntil: null, suspendedForDeletion: true })
  expect((await tries()).profile).toBe(200)
  // Lifted: everything works again.
  await db.doc(`userInternal/${a.uid}`).update({ suspendedForDeletion: false })
  expect((await tries()).message).toBe(403)
  await callAs(admin.uid, 'adminModerate', { uid: a.uid, action: 'unsuspend' })
  const after = await tries()
  for (const [k, v] of Object.entries(after)) expect([k, v]).toEqual([k, 200])
})
