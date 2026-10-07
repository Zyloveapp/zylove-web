// Stage A (2026-10-07): the adversarial audit's emulator proofs, kept as
// regression tests. Each asserts the secure behaviour.
import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, callAs, likeAs, idTokenFor, db, fnLib, sortedPair, PROJECT, setPlan } from './helpers.mjs'

test.beforeEach(resetEmulators)

const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
const BUCKET = 'demo-zylove.appspot.com'
const auth = async (uid) => ({ Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' })
const value = (v) =>
  v === null ? { nullValue: null }
  : typeof v === 'string' ? { stringValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'boolean' ? { booleanValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(value) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } }
const fields = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, value(v)]))
// Create (fails if it exists) — as the user, rules applied.
async function restCreate(uid, collectionPath, id, data) {
  return (await fetch(`${BASE}/${collectionPath}?documentId=${encodeURIComponent(id)}`, { method: 'POST', headers: await auth(uid), body: JSON.stringify({ fields: fields(data) }) })).status
}
async function restPatch(uid, path, data, mask = Object.keys(data)) {
  const q = mask.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&')
  return (await fetch(`${BASE}/${path}?${q}`, { method: 'PATCH', headers: await auth(uid), body: JSON.stringify({ fields: fields(data) }) })).status
}
// Firebase Storage client API on the emulator, as the user (storage.rules applied).
// The same multipart upload the Firebase web SDK sends.
// A real JPEG: the server removes malformed files (Stage B).
const JPEG = (await import('node:fs')).readFileSync(new URL('../fixture.jpg', import.meta.url))
async function storageUpload(uid, path, bytes = JPEG, contentType = 'image/jpeg') {
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
async function storageDelete(uid, path) {
  const tok = await idTokenFor(uid)
  return (await fetch(`http://127.0.0.1:9909/v0/b/${BUCKET}/o/${encodeURIComponent(path)}`, { method: 'DELETE', headers: { Authorization: `Firebase ${tok}` } })).status
}
async function mutualMatch(a, b, mode = 'spark') {
  await likeAs(a.uid, b.uid, mode)
  const r = await likeAs(b.uid, a.uid, mode)
  expect(r.matched).toBe(true)
  return sortedPair(a.uid, b.uid)
}

test('C1 forced match: a self-written likeQueue entry + likeBack must not match someone who never liked you (who blocked you)', async () => {
  const x = await seedUser('Xan')
  const v = await seedUser('Vee', { genderIdentity: 'woman', attractedTo: ['men'] })
  await callAs(v.uid, 'blockUser', { targetUid: x.uid })
  const wrote = await restCreate(x.uid, `users/${x.uid}/likeQueue`, v.uid, { mode: 'spark', likedAt: Date.now() })
  let matched = false
  try { await callAs(x.uid, 'likeBack', { likerUid: v.uid, mode: 'spark' }); matched = true } catch {}
  const m = await db.doc(`matches/${sortedPair(x.uid, v.uid)}`).get()
  console.log(`C1: likeQueue self-write HTTP ${wrote}; likeBack succeeded: ${matched}; match exists: ${m.exists}`)
  expect(m.exists).toBe(false)
})

test('C2 match tampering: a participant must not rewrite users / mode / isBot / isBlocked / participantSnapshots / matchGeneration', async () => {
  const a = await seedUser('Ann')
  const b = await seedUser('Bea', { genderIdentity: 'woman', attractedTo: ['men'] })
  const c = await seedUser('Cat', { genderIdentity: 'woman', attractedTo: ['men'] })
  const id = await mutualMatch(a, b)
  const res = {}
  const original = (await db.doc(`matches/${id}`).get()).data()
  // Each field on the untouched match (restored between tries).
  for (const [k, v] of [['users', [a.uid, c.uid]], ['mode', 'play'], ['isBot', true], ['isBlocked', true], ['blockedBy', 'someone'], ['unmatchedAt', 1], ['matchGeneration', 99], ['lastMessageSmsAt', null], ['participantSnapshots', { [a.uid]: { displayName: 'x', photoURL: 'https://attacker.invalid/p.gif' } }]]) {
    res[k] = await restPatch(a.uid, `matches/${id}`, { [k]: v })
    await db.doc(`matches/${id}`).set(original)
  }
  console.log('C2 match field updates by a participant (HTTP):', JSON.stringify(res))
  for (const [k, s] of Object.entries(res)) expect(s, k).toBe(403)
})

test('C2b match deletion: one participant must not delete the match (and the other side\'s chat/evidence)', async () => {
  const a = await seedUser('Ann')
  const b = await seedUser('Bea', { genderIdentity: 'woman', attractedTo: ['men'] })
  const id = await mutualMatch(a, b)
  const s = (await fetch(`${BASE}/matches/${id}`, { method: 'DELETE', headers: await auth(a.uid) })).status
  console.log('C2b DELETE match by participant:', s)
  expect(s).toBe(403)
})

test('H-1 chat photo storageRef: a message must not point at a file outside chat-photos/{matchId}/ (sweep deletes it as admin)', async () => {
  const a = await seedUser('Ann')
  const b = await seedUser('Bea', { genderIdentity: 'woman', attractedTo: ['men'] })
  const v = await seedUser('Vic')
  const id = await mutualMatch(a, b)
  const victimPath = `photos/${v.uid}/spark/victim.jpg`
  expect(await storageUpload(v.uid, victimPath)).toBe(200)
  const s = await restCreate(a.uid, `matches/${id}/messages`, 'evil1', { senderId: a.uid, messageType: 'photo', storageRef: victimPath, timerSeconds: 1, ciphertext: 'x', nonce: 'y' })
  console.log('H-1 create photo message pointing at another user\'s file:', s)
  if (s === 200) {
    await callAs(b.uid, 'markChatPhotoViewed', { matchId: id, messageId: 'evil1' })
    await new Promise((r) => setTimeout(r, 1500)) // the 1-second timer runs out
    console.log('H-1 expiry record queued:', (await db.doc(`photoExpiries/${id}_evil1`).get()).exists)
    const sweep = fnLib('photos').sweepChatPhotos
    await sweep.run({})
    const { getStorage } = (await import('module')).createRequire(new URL('../web-fn/package.json', import.meta.url).pathname)('firebase-admin/storage')
    const [exists] = await getStorage().bucket(BUCKET).file(victimPath).exists()
    console.log('H-1 victim file still exists after sweep:', exists)
    expect(exists).toBe(true)
  }
  expect(s).toBe(403)
})

test('H-2 photo swap: the owner must not be able to delete a published photo and re-upload different bytes under the same name', async () => {
  const a = await seedUser('Ann')
  const path = `photos/${a.uid}/spark/pub.jpg`
  expect(await storageUpload(a.uid, path)).toBe(200)
  await db.doc(`users/${a.uid}`).update({ photoURLs: [path] }) // as if approved and published
  const del = await storageDelete(a.uid, path)
  const re = del === 204 || del === 200 ? await storageUpload(a.uid, path, Buffer.concat([JPEG.subarray(0, JPEG.length - 2), Buffer.from([0, 0xff, 0xd9])])) : null
  const stillListed = ((await db.doc(`users/${a.uid}`).get()).get('photoURLs') ?? []).includes(path)
  console.log(`H-2 delete published photo: ${del}; re-upload same name: ${re}; ref still in photoURLs: ${stillListed}`)
  // Secure: either the re-upload is refused, or the ref no longer points at published bytes.
  expect(re === 200 && stillListed).toBe(false)
})

test('H1 unblockUser: the blocked person must not lift a block placed on them', async () => {
  const x = await seedUser('Xan')
  const v = await seedUser('Vee', { genderIdentity: 'woman', attractedTo: ['men'] })
  await callAs(v.uid, 'blockUser', { targetUid: x.uid })
  let r = 'ok'
  try { await callAs(x.uid, 'unblockUser', { targetUid: v.uid }) } catch (e) { r = String(e.message).slice(0, 80) }
  const still = (await db.doc(`users/${v.uid}/blockedUsers/${x.uid}`).get()).exists
  console.log(`H1 unblockUser by the blocked person: ${r}; victim's block still there: ${still}`)
  expect(still).toBe(true)
})

test('H2 blockUser: an outsider must not end two other people\'s match via matchId', async () => {
  const a = await seedUser('Ann')
  const b = await seedUser('Bea', { genderIdentity: 'woman', attractedTo: ['men'] })
  const c = await seedUser('Cal')
  const id = await mutualMatch(a, b)
  let r = 'ok'
  try { await callAs(c.uid, 'blockUser', { targetUid: a.uid, matchId: id }) } catch (e) { r = String(e.message).slice(0, 80) }
  const m = (await db.doc(`matches/${id}`).get()).data()
  console.log(`H2 outsider blockUser with their matchId: ${r}; match isBlocked: ${m.isBlocked}`)
  expect(m.isBlocked === true).toBe(false)
})

test('H3 suspension evasion: cancelAccountDeletion must not lift an admin suspension', async () => {
  const a = await seedUser('Ann')
  await db.doc(`userInternal/${a.uid}`).set({ isSuspended: true, suspendedBy: 'admin', suspendSource: 'admin' }, { merge: true })
  let r = 'ok'
  try { await callAs(a.uid, 'cancelAccountDeletion', {}) } catch (e) { r = String(e.message).slice(0, 80) }
  const s = (await db.doc(`userInternal/${a.uid}`).get()).get('isSuspended')
  console.log(`H3 cancelAccountDeletion while admin-suspended: ${r}; isSuspended after: ${s}`)
  expect(s).toBe(true)
})

test('H4 cross-mode like: a Spark like must not turn into a Play match (both have Play)', async () => {
  const PLAY = (n) => ({ playDisplayName: n, playBio: 'b', spiceLevel: 'mild' })
  const a = await seedUser('Ari', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ari') })
  const b = await seedUser('Bex', { genderIdentity: 'woman', attractedTo: ['men'], intent: 'open', onboardingPath: 'both' }, { play: PLAY('Bex') })
  await likeAs(b.uid, a.uid, 'spark') // B likes A in Spark only
  const r = await likeAs(a.uid, b.uid, 'play') // A likes B in Play
  const m = (await db.doc(`matches/${sortedPair(a.uid, b.uid)}`).get()).data()
  console.log('H4 Spark like + Play like →', JSON.stringify(r), 'match mode:', m?.mode)
  expect(r.matched).not.toBe(true)
})

test('#10 isBot on own public doc: a user must not make themselves unreportable', async () => {
  const a = await seedUser('Ann')
  const s = await restPatch(a.uid, `users/${a.uid}`, { isBot: true })
  console.log('#10 set own isBot:', s)
  expect(s).toBe(403)
})

test('#11 own root doc delete: must not be allowed (it resets identityLockedAt)', async () => {
  const a = await seedUser('Ann')
  const s = (await fetch(`${BASE}/users/${a.uid}`, { method: 'DELETE', headers: await auth(a.uid) })).status
  console.log('#11 DELETE own users doc:', s)
  expect(s).toBe(403)
})

test('blocks forgery: the blocked person must not unblock themselves via a forged blocks doc + unblockMember', async () => {
  const x = await seedUser('Xan')
  const v = await seedUser('Vee', { genderIdentity: 'woman', attractedTo: ['men'] })
  await callAs(v.uid, 'blockUser', { targetUid: x.uid })
  const forged = await restCreate(x.uid, 'blocks', 'forged1', { blockerUid: x.uid, blockedUid: v.uid })
  let r = 'ok'
  try { await callAs(x.uid, 'unblockMember', { targetUid: v.uid }) } catch (e) { r = String(e.message).slice(0, 80) }
  const still = (await db.doc(`users/${v.uid}/blockedUsers/${x.uid}`).get()).exists
  console.log(`blocks forgery: create ${forged}; unblockMember: ${r}; victim's block still there: ${still}`)
  expect(still).toBe(true)
})

test('block: the blocker keeps read-only access to the chat; the blocked person loses it; no new messages either way', async () => {
  const x = await seedUser('Xan')
  const v = await seedUser('Vee', { genderIdentity: 'woman', attractedTo: ['men'] })
  const id = await mutualMatch(x, v)
  expect(await restCreate(x.uid, `matches/${id}/messages`, 'm1', { senderId: x.uid, messageType: 'text', ciphertext: 'hi', nonce: 'stub', status: 'sent', sentAt: '2020-01-01' })).toBe(403) // a client-chosen sentAt is refused
  await db.doc(`matches/${id}/messages/m0`).set({ senderId: x.uid, messageType: 'text', ciphertext: 'hello', nonce: 'stub', status: 'sent', sentAt: new Date() })
  await callAs(v.uid, 'blockUser', { targetUid: x.uid, matchId: id })
  const get = async (uid, p) => (await fetch(`${BASE}/${p}`, { headers: await auth(uid) })).status
  expect(await get(v.uid, `matches/${id}`)).toBe(200)
  expect(await get(v.uid, `matches/${id}/messages/m0`)).toBe(200)
  expect(await get(x.uid, `matches/${id}`)).toBe(403)
  expect(await get(x.uid, `matches/${id}/messages/m0`)).toBe(403)
  for (const u of [x, v]) {
    const r = await fetch(`${BASE}/matches/${id}/messages?documentId=n_${u.name}`, { method: 'POST', headers: await auth(u.uid), body: JSON.stringify({ fields: { senderId: value(u.uid), messageType: value('text'), ciphertext: value('x'), nonce: value('stub'), status: value('sent'), sentAt: { timestampValue: new Date().toISOString() } } }) })
    expect(r.status, u.name).toBe(403)
  }
  // And liking again doesn't bring them back.
  await expect(likeAs(x.uid, v.uid)).rejects.toThrow(/not available|failed-precondition|FAILED_PRECONDITION/i)
})

test('unmatch: a later like alone does not re-create the match', async () => {
  const a = await seedUser('Ann')
  const b = await seedUser('Bea', { genderIdentity: 'woman', attractedTo: ['men'] })
  const id = await mutualMatch(a, b)
  await callAs(a.uid, 'unmatchConnection', { matchId: id })
  await expect.poll(async () => (await db.doc(`matches/${id}`).get()).exists).toBe(false)
  const r = await likeAs(a.uid, b.uid)
  expect(r.matched).toBe(false)
  expect((await db.doc(`matches/${id}`).get()).exists).toBe(false)
  // Both liking again does.
  expect((await likeAs(b.uid, a.uid)).matched).toBe(true)
})

test('likeBack: a real like in that mode still matches', async () => {
  const a = await seedUser('Ann')
  await setPlan(a.uid, 'spark_plus') // Stage C: liking back is Spark+
  const b = await seedUser('Bea', { genderIdentity: 'woman', attractedTo: ['men'] })
  await likeAs(b.uid, a.uid)
  const r = await callAs(a.uid, 'likeBack', { likerUid: b.uid, mode: 'spark' })
  expect(r.matched).toBe(true)
  // A queue entry in the other mode doesn't count.
  const c = await seedUser('Cat', { genderIdentity: 'woman', attractedTo: ['men'] })
  await likeAs(c.uid, a.uid)
  await expect(callAs(a.uid, 'likeBack', { likerUid: c.uid, mode: 'play' })).rejects.toThrow()
})

test('photos: the server deletes a photo once it is off every list (clients can\'t delete)', async () => {
  const a = await seedUser('Ann')
  const path = `photos/${a.uid}/spark/gone.jpg`
  const { getStorage } = (await import('module')).createRequire(new URL('../web-fn/package.json', import.meta.url).pathname)('firebase-admin/storage')
  const file = getStorage().bucket(BUCKET).file(path)
  await file.save(Buffer.from([1, 2, 3]), { contentType: 'image/jpeg', metadata: { metadata: { zyloveCopy: '1' } } })
  await db.doc(`users/${a.uid}`).update({ photoURLs: [path, 'photos/other/spark/x.jpg'] })
  expect(await storageDelete(a.uid, path)).toBe(403)
  // The owner removes it from their profile (the app's removeProfilePhoto).
  expect(await restPatch(a.uid, `users/${a.uid}`, { photoURLs: ['photos/other/spark/x.jpg'] })).toBe(200)
  await expect.poll(async () => (await file.exists())[0], { timeout: 20000 }).toBe(false)
})
