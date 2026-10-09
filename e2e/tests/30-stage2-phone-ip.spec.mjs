// Final review, stage 2 (2026-10): F-072 (validatePhoneNumber is no account
// oracle, and fails closed for new numbers once the day's Lookup budget is
// spent), F-073 (the caller's address is the last X-Forwarded-For hop, not a
// client-sent first one: functions/src/clientIp.ts, unit-tested in
// functions/test/clientIp.test.ts) and F-074 (scam reports hide the account
// pending review instead of suspending it, and only reporters who talked
// with it count).
//
// The emulator has no front end appending the real hop, so every call here
// comes from the same (unknown) address: the per-address limit is shared,
// and a spoofed header can only be checked for not winning.
import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, fnLib, sortedPair, internalDoc, PROJECT } from './helpers.mjs'

test.beforeEach(resetEmulators)

const DAY = 864e5
const FN = `http://127.0.0.1:5311/${PROJECT}/us-central1`
const CONSENTS = ['age', 'terms', 'privacy', 'matching', 'conduct', 'safety']

// validatePhoneNumber as the Login page calls it: signed out.
async function checkPhone(phoneNumber, headers = {}) {
  const r = await fetch(`${FN}/validatePhoneNumber`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ data: { phoneNumber } }) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok || body.error) throw new Error(`validatePhoneNumber → HTTP ${r.status} ${JSON.stringify(body.error ?? body)}`)
  return body.result
}
// A number no account has (the 555-01xx fiction range, past seedUser's).
const freshNumber = (i) => `+1555019${String(1000 + i).slice(-4)}`

const woman = (name, o = {}) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o })
async function matchOf(a, b) {
  await likeAs(a.uid, b.uid)
  const r = await likeAs(b.uid, a.uid)
  expect(r.matched).toBe(true)
  return sortedPair(a.uid, b.uid)
}
const adminMessage = (matchId, senderId) =>
  db.collection(`matches/${matchId}/messages`).add({ senderId, messageType: 'text', ciphertext: 'x', nonce: 'n', status: 'sent', sentAt: new Date() })
const setCreated = (uid, ms) => db.doc(`userInternal/${uid}`).set({ accountCreatedAt: ms }, { merge: true })

// ─── F-072: validatePhoneNumber ──────────────────────────────────────────────

test('F-072: over the per-address limit, an existing and a new number get the same answer', async () => {
  const existing = await seedUser('Eve')
  // Under the limit, an existing account is allowed (no Lookup).
  expect(await checkPhone(existing.phone)).toEqual({ allowed: true })
  // Fill the address's hour (10 checks in all) with new numbers.
  for (let i = 0; i < 9; i++) await checkPhone(freshNumber(i))
  const forExisting = await checkPhone(existing.phone)
  const forNew = await checkPhone(freshNumber(50))
  expect(forExisting).toEqual({ allowed: false, reason: 'rate_limited' })
  expect(forNew).toEqual(forExisting)
  // Keyed by a hash of the address, never the address.
  const limits = await db.collection('rateLimits').get()
  expect(limits.docs.some((d) => /^ip_[0-9a-f]{32}$/.test(d.id) && Array.isArray(d.data().phoneLookup))).toBe(true)
})

test('F-072: once the daily Lookup budget is spent, new numbers are refused and existing accounts still get in', async () => {
  const existing = await seedUser('Eve')
  const day = new Date().toISOString().slice(0, 10)
  await db.doc(`rateLimits/_phoneLookup_${day}`).set({ count: 1000 })
  expect(await checkPhone(freshNumber(1))).toEqual({ allowed: false, reason: 'rate_limited' })
  expect(await checkPhone(existing.phone)).toEqual({ allowed: true })
  // The budget isn't taken past its cap.
  expect((await db.doc(`rateLimits/_phoneLookup_${day}`).get()).data().count).toBe(1000)
})

// ─── F-073: the caller's address ─────────────────────────────────────────────

test('F-073: a spoofed first X-Forwarded-For hop is never recorded as the Terms-acceptance address', async () => {
  const a = await seedUser('Ivo')
  const accept = async (headers = {}) => {
    const r = await fetch(`${FN}/recordTermsAcceptance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await idTokenFor(a.uid)}`, ...headers },
      body: JSON.stringify({ data: { consents: CONSENTS } }),
    })
    expect(r.ok).toBe(true)
    return (await db.doc(`users/${a.uid}/legalAcceptance/main`).get()).data().ip
  }
  const plain = await accept()
  const spoofed = await accept({ 'X-Forwarded-For': '6.6.6.6, 198.51.100.7' })
  // The last hop if the emulator passes the header on, else what it records
  // with none — never the client's own first entry.
  expect(spoofed).not.toBe('6.6.6.6')
  expect([plain, '198.51.100.7']).toContain(spoofed)
})

// ─── F-074: scam reports ─────────────────────────────────────────────────────

test('F-074: reporters with no messages don\'t count; two who talked with them hide the account pending review, not suspend it', async () => {
  const t = await woman('Tess')
  const [r1, r2, r3, r4] = await Promise.all(['Rob', 'Ray', 'Rex', 'Roy'].map((n) => seedUser(n)))
  const matches = {}
  for (const r of [r1, r2, r3, r4]) matches[r.uid] = await matchOf(r, t)
  for (const r of [r1, r2, r3, r4]) await setCreated(r.uid, Date.now() - 10 * DAY)
  // Rob and Ray talked with Tess. Rex only wrote to her; Roy never wrote.
  for (const r of [r1, r2]) {
    await adminMessage(matches[r.uid], r.uid)
    await adminMessage(matches[r.uid], t.uid)
  }
  await adminMessage(matches[r3.uid], r3.uid)
  await expect.poll(async () => (await db.doc(`exploreIndex/${t.uid}`).get()).exists, { timeout: 20000 }).toBe(true)
  const report = (r) => callAs(r.uid, 'submitReport', { matchId: matches[r.uid], reportedUid: t.uid, categories: ['scam'] })

  await report(r3)
  await report(r4)
  await report(r1)
  // Three reporters, one who counts.
  expect((await internalDoc(t.uid)).hiddenPendingReview).toBeUndefined()
  expect((await db.doc(`exploreIndex/${t.uid}`).get()).exists).toBe(true)

  await report(r2)
  const n = await internalDoc(t.uid)
  expect(n.hiddenPendingReview).toMatchObject({ source: 'scam_reports', reporters: 2 })
  expect(n.isSuspended).not.toBe(true)
  expect(n.suspendSource).toBeUndefined()
  // Out of Explore, but signed in and still in her chats.
  expect((await db.doc(`exploreIndex/${t.uid}`).get()).exists).toBe(false)
  expect(await fnLib('appeals').suspensionRefusal(t.uid)).toBeNull()
  await callAs(t.uid, 'recordDevice', { deviceId: 'dev_' + 't'.repeat(20) })
  expect((await db.doc(`matches/${matches[r1.uid]}`).get()).data().isBlocked).not.toBe(true)
  // A refresh of her index entry (any profile write) keeps her out.
  await fnLib('explore').refreshEntry(t.uid)
  expect((await db.doc(`exploreIndex/${t.uid}`).get()).exists).toBe(false)
  // The urgent admin alert still goes out, with the flag at the top of the queue.
  expect((await db.doc(`trustFlags/${t.uid}`).get()).data().status).toBe('open')
  expect((await db.collection('adminAudit').where('action', '==', 'trust.auto_hide').get()).size).toBe(1)

  // Clients can't see or set the hold (userInternal is server-only).
  const r = await fetch(`http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents/userInternal/${t.uid}`, {
    headers: { Authorization: `Bearer ${await idTokenFor(t.uid)}` },
  })
  expect(r.status).toBe(403)
})
