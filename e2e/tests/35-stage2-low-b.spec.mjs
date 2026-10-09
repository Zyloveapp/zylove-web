// Final review, stage 2 Low (b): F-078 (a kept chat's leaver can't act on
// it; its keeper still can), F-091 (old Storage paths shut, chat photos
// follow block and unmatch), F-094 (admin checks first, audits before and
// after, refused admin calls logged, name search), F-096 (deleted accounts
// don't come back) and F-097 (requireActive, contact re-request wait,
// Twilio replays).
import { test, expect } from '@playwright/test'
import { createHmac } from 'node:crypto'
import {
  resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, PROJECT, playIdOf, playMatchOf, sortedPair, setPlan, Timestamp, internalDoc, accountDoc,
} from './helpers.mjs'

test.beforeEach(resetEmulators)

const BUCKET = 'demo-zylove.appspot.com'
const STORAGE = `http://127.0.0.1:9909/v0/b/${BUCKET}/o`
async function upload(uid, path, contentType = 'image/x-zylove-encrypted') {
  const boundary = 'b' + Math.random().toString(36).slice(2)
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ name: path, contentType })}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.from('sealed'),
    Buffer.from(`\r\n--${boundary}--`),
  ])
  return (await fetch(`${STORAGE}?name=${encodeURIComponent(path)}`, {
    method: 'POST', headers: { Authorization: `Firebase ${await idTokenFor(uid)}`, 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).status
}
const read = async (uid, path) => (await fetch(`${STORAGE}/${encodeURIComponent(path)}?alt=media`, { headers: { Authorization: `Firebase ${await idTokenFor(uid)}` } })).status
const errOf = (p) => p.then(() => null, (e) => String(e.message))
const audits = async (action) => (await db.collection('adminAudit').where('action', '==', action).get()).docs.map((d) => d.data())
const PLAY = (name) => ({ playDisplayName: name, playBio: `${name}'s Play bio`, spiceLevel: 'spicy', playInterestTags: ['fwb'] })
const woman = (name, o = {}, opts) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o }, opts)

async function sparkMatch(a, b) {
  await likeAs(a.uid, b.uid)
  expect((await likeAs(b.uid, a.uid)).matched).toBe(true)
  return sortedPair(a.uid, b.uid)
}
const col = (matchId) => (matchId.startsWith('pm_') ? 'playMatches' : 'matches')
const say = (matchId, senderId, n) =>
  Promise.all(Array.from({ length: n }, (_, i) => db.collection(`${col(matchId)}/${matchId}/messages`).add({ senderId, messageType: 'text', ciphertext: 'x', nonce: 'n', status: 'sent', sentAt: new Date(Date.now() + i) })))

// ─── F-078: kept chats ───────────────────────────────────────────────────────

test('F-078: in a Play chat kept for the other person, the one who left can\'t revoke contact cards, mark or read chat photos; the keeper can still block from it', async () => {
  const a = await seedUser('Adam', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ember') })
  const b = await woman('Bella', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Velvet') })
  for (const u of [a, b]) await setPlan(u.uid, 'elite')
  await likeAs(a.uid, b.uid, 'play')
  await likeAs(b.uid, a.uid, 'play')
  const matchId = await playMatchOf(a.uid, b.uid)
  const [aPlay, bPlay] = [await playIdOf(a.uid), await playIdOf(b.uid)]
  // A photo from Bella and an accepted contact exchange, before Adam leaves.
  await db.doc(`playMatches/${matchId}`).update({ photoConsent: { status: 'accepted', requestedBy: bPlay }, contactExchange: { status: 'accepted', requestedBy: bPlay, requestedAt: Date.now() } })
  const photo = `chat-photos/${matchId}/${bPlay}_1.bin`
  expect(await upload(b.uid, photo)).toBe(200)
  const msg = await db.collection(`playMatches/${matchId}/messages`).add({ senderId: bPlay, messageType: 'photo', storageRef: photo, timerSeconds: 0, firstViewedAt: null, destructedAt: null, status: 'sent', sentAt: new Date() })
  expect(await read(a.uid, photo)).toBe(200)

  await callAs(a.uid, 'unmatchConnection', { matchId })
  expect((await db.doc(`playMatches/${matchId}`).get()).data()).toMatchObject({ players: [bPlay], preservedFor: [bPlay] })
  // The server-only record still names both; the leaver acts on nothing.
  expect((await db.doc(`playMatchMembers/${matchId}`).get()).data().users).toContain(a.uid)
  expect(await errOf(callAs(a.uid, 'revokeContactExchange', { matchId }))).toMatch(/Not a participant/)
  expect((await db.doc(`playMatches/${matchId}`).get()).data().contactExchange.status).toBe('accepted')
  expect(await errOf(callAs(a.uid, 'markChatPhotoViewed', { matchId, messageId: msg.id }))).toMatch(/Not a participant/)
  expect(await read(a.uid, photo)).toBe(403)
  expect(await read(b.uid, photo)).toBe(200)
  // Bella, who keeps it, can still block him from it.
  await callAs(b.uid, 'blockUser', { targetUid: aPlay, matchId })
  expect((await db.doc(`playMatches/${matchId}`).get()).data()).toMatchObject({ isBlocked: true, blockedBy: bPlay })
})

test('F-078: in a Spark chat kept for the other person, the keeper can block from it (only they are in users)', async () => {
  const c = await seedUser('Cal')
  const d = await woman('Dee')
  const id = await sparkMatch(c, d)
  await callAs(c.uid, 'unmatchConnection', { matchId: id })
  expect((await db.doc(`matches/${id}`).get()).data()).toMatchObject({ users: [d.uid], preservedFor: [d.uid] })
  // The leaver can't block through it (still can without the match).
  expect(await errOf(callAs(c.uid, 'blockUser', { targetUid: d.uid, matchId: id }))).toMatch(/Not your match/)
  await callAs(d.uid, 'blockUser', { targetUid: c.uid, matchId: id })
  expect((await db.doc(`matches/${id}`).get()).data()).toMatchObject({ isBlocked: true, blockedBy: d.uid })
  expect((await db.doc(`users/${d.uid}/blockedUsers/${c.uid}`).get()).data()).toMatchObject({ blockedBy: d.uid })
})

// ─── F-091: Storage ──────────────────────────────────────────────────────────

test('F-091: the mobile-era users/{uid}/photos, verification and consent paths take no uploads', async () => {
  const a = await seedUser('Ann')
  for (const dir of ['photos', 'verification', 'consent']) {
    expect([dir, await upload(a.uid, `users/${a.uid}/${dir}/x.jpg`, 'image/jpeg')]).toEqual([dir, 403])
  }
  // The live profile path still works.
  expect(await upload(a.uid, `photos/${a.uid}/spark/x.jpg`, 'image/jpeg')).toBe(200)
})

test('F-091: after a block, nobody can add a chat photo; the blocker still reads them, and the person blocked only for the 30-day report window (H5)', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  await setPlan(a.uid, 'spark_plus')
  await setPlan(b.uid, 'spark_plus')
  const id = await sparkMatch(a, b)
  await db.doc(`matches/${id}`).update({ photoConsent: { status: 'accepted', requestedBy: a.uid } })
  const photo = `chat-photos/${id}/${b.uid}_1.bin`
  expect(await upload(b.uid, photo)).toBe(200)
  expect(await read(a.uid, photo)).toBe(200)
  expect(await read(b.uid, photo)).toBe(200)
  await callAs(a.uid, 'blockUser', { targetUid: b.uid, matchId: id })
  expect(await read(b.uid, photo)).toBe(200) // the person blocked, within the window (H5)
  expect(await read(a.uid, photo)).toBe(200) // the blocker's evidence
  expect(await upload(a.uid, `chat-photos/${id}/${a.uid}_2.bin`)).toBe(403)
  expect(await upload(b.uid, `chat-photos/${id}/${b.uid}_2.bin`)).toBe(403)
  await db.doc(`matches/${id}`).update({ preservedUntil: Timestamp.fromMillis(Date.now() - 1000) })
  expect(await read(b.uid, photo)).toBe(403) // past it
  expect(await read(a.uid, photo)).toBe(200)
})

test('F-091: no chat photos into an unmatched chat (kept read-only), though its keeper still sees them', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  await setPlan(a.uid, 'spark_plus')
  const id = await sparkMatch(a, b)
  await db.doc(`matches/${id}`).update({ photoConsent: { status: 'accepted', requestedBy: b.uid } })
  const photo = `chat-photos/${id}/${a.uid}_1.bin`
  expect(await upload(a.uid, photo)).toBe(200)
  await callAs(b.uid, 'unmatchConnection', { matchId: id })
  expect((await db.doc(`matches/${id}`).get()).data().preservedFor).toEqual([a.uid])
  expect(await read(a.uid, photo)).toBe(200)
  expect(await read(b.uid, photo)).toBe(403)
  expect(await upload(a.uid, `chat-photos/${id}/${a.uid}_2.bin`)).toBe(403)
})

// ─── F-094: admin paths ──────────────────────────────────────────────────────

test('F-094: the directory finds someone by a name prefix', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const z = await seedUser('Zora')
  await callAs(z.uid, 'initUserDefaults') // writes the name index
  expect((await internalDoc(z.uid)).searchName).toBe('zora')
  const hits = (await callAs(admin.uid, 'adminSearchUsers', { q: 'Zo' })).results.map((r) => r.uid)
  expect(hits).toEqual([z.uid])
  expect((await callAs(admin.uid, 'adminSearchUsers', { q: 'zz' })).results).toEqual([])
})

test('F-094: a non-admin calling an admin callable is refused and logged (caller and call only, at most 5 a day)', async () => {
  const a = await seedUser('Ann')
  const target = await seedUser('Tia')
  for (let i = 0; i < 6; i++) expect(await errOf(callAs(a.uid, 'adminSearchUsers', { q: target.uid }))).toMatch(/Admins only/)
  expect(await errOf(callAs(a.uid, 'adminModerate', { uid: target.uid, action: 'suspend', days: 30 }))).toMatch(/Admins only/)
  const denied = await audits('admin.denied')
  expect(denied).toHaveLength(5)
  expect(denied.every((d) => d.actor === a.uid && d.target === null)).toBe(true)
  expect(denied[0].detail).toEqual({ call: 'adminSearchUsers' })
  // Nothing about the query, and nothing happened to the target.
  expect(JSON.stringify(denied)).not.toContain(target.uid)
  expect((await internalDoc(target.uid))?.isSuspended ?? false).toBe(false)
})

test('F-094: account-changing admin actions are logged as an attempt before acting and with the outcome after', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Ann')
  await callAs(admin.uid, 'adminModerate', { uid: a.uid, action: 'suspend', days: 30 })
  expect(await audits('report.suspend.attempt')).toEqual([expect.objectContaining({ actor: admin.uid, target: a.uid })])
  expect(await audits('report.suspend')).toEqual([expect.objectContaining({ actor: admin.uid, target: a.uid, detail: { days: 30 } })])
  await callAs(admin.uid, 'adminUserAction', { uid: a.uid, action: 'unsuspend' })
  expect(await audits('user.unsuspend.attempt')).toHaveLength(1)
  expect(await audits('user.unsuspend')).toHaveLength(1)
})

// ─── F-096: deleted accounts ─────────────────────────────────────────────────

test('F-096: a deleted account\'s still-valid session re-creates nothing (activity, Play ID, plan mirror)', async () => {
  const a = await seedUser('Ann', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ember') })
  // As a deletion leaves it: no Play ID mapping, the profile marked deleted
  // (the Play profile doc is left in place so getMyPlayId gets as far as
  // the Play ID).
  const playId = await playIdOf(a.uid)
  if (playId) await db.doc(`playIdOwners/${playId}`).delete()
  await db.doc(`playIds/${a.uid}`).delete()
  await db.doc(`users/${a.uid}`).update({ isDeleted: true })
  await db.doc(`userInternal/${a.uid}`).set({ lastActive: null }, { merge: true })
  await callAs(a.uid, 'recordActivity')
  expect((await internalDoc(a.uid)).lastActive).toBeNull()
  expect(await errOf(callAs(a.uid, 'getMyPlayId'))).toMatch(/isn't available/)
  expect((await db.doc(`playIds/${a.uid}`).get()).exists).toBe(false)
  // A plan change doesn't bring back the private/account mirror.
  await db.doc(`users/${a.uid}/private/account`).delete()
  await db.doc(`userInternal/${a.uid}`).set({ subscriptionTier: 'elite' }, { merge: true })
  await new Promise((r) => setTimeout(r, 3000))
  expect((await db.doc(`users/${a.uid}/private/account`).get()).exists).toBe(false)
})

test('F-096: an unmatch by a deleted account doesn\'t re-create its behaviour signals', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await sparkMatch(a, b)
  await say(id, a.uid, 2)
  await say(id, b.uid, 2)
  // (The match's own "created" count has landed first.)
  await expect.poll(async () => (await db.doc(`behaviorSignals/${a.uid}`).get()).data()?.matchCount ?? 0, { timeout: 15000 }).toBe(1)
  await db.doc(`users/${a.uid}`).update({ isDeleted: true })
  await db.doc(`behaviorSignals/${a.uid}`).delete()
  await db.doc(`matches/${id}`).update({ unmatchedAt: Timestamp.now(), unmatchedBy: a.uid })
  await expect.poll(async () => (await db.collection('pastConnections').where('matchId', '==', id).get()).size, { timeout: 15000 }).toBe(1)
  await new Promise((r) => setTimeout(r, 1500))
  expect((await db.doc(`behaviorSignals/${a.uid}`).get()).exists).toBe(false)
})

// ─── F-097 ───────────────────────────────────────────────────────────────────

test('F-097: a suspended account can\'t rename itself, claim a founder spot or become visible again — but can still hide', async () => {
  const a = await seedUser('Ann')
  // Suspended in the record only (adminModerate would also disable sign-in,
  // and this checks the server refusing a session that's still valid).
  await db.doc(`userInternal/${a.uid}`).set({ isSuspended: true, suspendedUntil: Timestamp.fromMillis(Date.now() + 864e5) }, { merge: true })
  expect(await errOf(callAs(a.uid, 'updateDisplayName', { mode: 'spark', displayName: 'Annie' }))).toMatch(/suspended/)
  expect(await errOf(callAs(a.uid, 'assignFounderBadge'))).toMatch(/suspended/)
  expect(await errOf(callAs(a.uid, 'initUserDefaults'))).toMatch(/suspended/)
  expect(await errOf(callAs(a.uid, 'setVisibility', { mode: 'spark', visibility: 'active' }))).toMatch(/suspended/)
  await callAs(a.uid, 'setVisibility', { mode: 'spark', visibility: 'hidden' })
  expect((await db.doc(`users/${a.uid}`).get()).data().sparkVisibility).toBe('hidden')
})

test('F-097: after a "no", the same person waits 24 hours to ask again, and after two noes can\'t ask at all (the other person still can)', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await sparkMatch(a, b)
  await say(id, a.uid, 3)
  await say(id, b.uid, 3)
  const ago = (h) => Date.now() - h * 3600_000
  await callAs(a.uid, 'requestContactExchange', { matchId: id })
  await callAs(b.uid, 'respondContactExchange', { matchId: id, accept: false })
  expect(await errOf(callAs(a.uid, 'requestContactExchange', { matchId: id }))).toMatch(/24 hours/)
  // A day later: allowed.
  await db.doc(`matches/${id}`).update({ 'contactExchange.respondedAt': ago(25) })
  await callAs(a.uid, 'requestContactExchange', { matchId: id })
  await callAs(b.uid, 'respondContactExchange', { matchId: id, accept: false })
  expect((await db.doc(`matches/${id}`).get()).data().contactExchange.declines).toEqual({ [a.uid]: 2 })
  await db.doc(`matches/${id}`).update({ 'contactExchange.respondedAt': ago(25) })
  expect(await errOf(callAs(a.uid, 'requestContactExchange', { matchId: id }))).toMatch(/can't ask again/)
  // Bea can still ask.
  await callAs(b.uid, 'requestContactExchange', { matchId: id })
  expect((await db.doc(`matches/${id}`).get()).data().contactExchange).toMatchObject({ status: 'pending', requestedBy: b.uid })
})

test('F-097: a revoked exchange makes its requester wait 24 hours too', async () => {
  const a = await seedUser('Ann')
  const b = await woman('Bea')
  const id = await sparkMatch(a, b)
  await say(id, a.uid, 3)
  await say(id, b.uid, 3)
  await callAs(a.uid, 'requestContactExchange', { matchId: id })
  await callAs(b.uid, 'respondContactExchange', { matchId: id, accept: true })
  await callAs(b.uid, 'revokeContactExchange', { matchId: id })
  expect(await errOf(callAs(a.uid, 'requestContactExchange', { matchId: id }))).toMatch(/24 hours/)
})

// Twilio inbound, signed as Twilio would (17-sms-consent.spec.mjs).
const TOKEN = process.env.TWILIO_AUTH_TOKEN
async function inbound(params) {
  const host = '127.0.0.1:5311'
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], `https://${host}/twilioInbound`)
  const signature = createHmac('sha1', TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64')
  return fetch(`http://${host}/${PROJECT}/us-central1/twilioInbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    body: new URLSearchParams(params).toString(),
  })
}

test('F-097: a replayed Twilio message (same MessageSid) is ignored — an old STOP can\'t undo a later START', async () => {
  test.skip(!TOKEN, 'TWILIO_AUTH_TOKEN not set (e2e/.env.test)')
  const me = await seedUser('Vale', { smsNotificationsEnabled: { spark: true, play: true } })
  await db.doc(`users/${me.uid}/private/account`).set({ smsConsent: { grantedAt: new Date(), phone: me.phone, textVersion: '2026-10-07' } }, { merge: true })
  const stop = { From: me.phone, To: '+15125550000', Body: 'STOP', MessageSid: 'SMreplay0000000000000000000000001' }
  expect((await inbound(stop)).status).toBe(200)
  expect((await db.doc(`smsOptOuts/${me.phone}`).get()).exists).toBe(true)
  expect((await db.doc(`twilioInboundSeen/${stop.MessageSid}`).get()).exists).toBe(true)
  expect((await inbound({ From: me.phone, To: '+15125550000', Body: 'START', MessageSid: 'SMreplay0000000000000000000000002' })).status).toBe(200)
  expect((await db.doc(`smsOptOuts/${me.phone}`).get()).exists).toBe(false)
  // The captured STOP again: accepted (200, so it isn't retried) but changes nothing.
  const replay = await inbound(stop)
  expect(replay.status).toBe(200)
  expect(await replay.text()).toContain('<Response></Response>')
  expect((await db.doc(`smsOptOuts/${me.phone}`).get()).exists).toBe(false)
  expect((await accountDoc(me.uid)).smsOptOut).toBeUndefined()
})
