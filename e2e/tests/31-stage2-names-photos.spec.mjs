// Final launch review, stage 2 (2026-10): F-079 (public names — the first
// name is checked by the rules, names in texts are sanitised, and deleting
// the Play profile no longer resets the Play name's 30-day lock), F-081
// (photos flagged for their content stay in review whatever the owner does)
// and F-087 (a duplicate photo counts against the newer uploader only, and
// never opens a trust flag alone).
import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, callAs, idTokenFor, db, fnLib, PROJECT, Timestamp, adminAuth, accountDoc, internalDoc, userDoc } from './helpers.mjs'

test.beforeEach(resetEmulators)

const BASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
async function rest(uid, path, init = {}) {
  const r = await fetch(`${BASE}/${path}`, { ...init, headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  return r.status
}
// A REST field map from plain values (strings, numbers, booleans, [] for an empty list).
const fields = (o) => ({
  fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? { arrayValue: { values: [] } } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v } : { stringValue: v }])),
})
const create = (uid, coll, id, o) => rest(uid, `${coll}?documentId=${id}`, { method: 'POST', body: JSON.stringify(fields(o)) })
const patch = (uid, path, o) => rest(uid, `${path}?${Object.keys(o).map((k) => `updateMask.fieldPaths=${k}`).join('&')}`, { method: 'PATCH', body: JSON.stringify(fields(o)) })
const errOf = (p) => p.then(() => null, (e) => String(e.message))
const PLAY = (name) => ({ playDisplayName: name, playBio: `${name}'s Play bio`, spiceLevel: 'spicy', playInterestTags: ['fwb'] })

const BUCKET = 'demo-zylove.appspot.com'
const JPEG = (await import('node:fs')).readFileSync(new URL('../fixture.jpg', import.meta.url))
async function bucket() {
  fnLib('userData') // initialises the admin app for Storage
  const { getStorage } = await import('firebase-admin/storage')
  return getStorage().bucket(BUCKET)
}
// A profile photo as the app uploads it (onPhotoUpload moderates it).
const upload = async (path) => (await bucket()).file(path).save(JPEG, { contentType: 'image/jpeg' })
const fileExists = async (path) => (await (await bucket()).file(path).exists())[0]

// ─── F-079: names ─────────────────────────────────────────────────────────────

test('F-079: the first displayName must be a name — on create and on the first update; after that it is locked', async () => {
  // Create: a brand-new profile.
  const uid = `e2e-fresh-${Date.now()}`
  await adminAuth.createUser({ uid })
  // Austin-only launch: admitted by the location check (else every create is refused).
  await db.doc(`userInternal/${uid}`).set({ admission: { status: 'admitted', cityId: 'austin' } })
  for (const bad of ['visit bit.ly/x', 'A', 'x'.repeat(21), 'call 5125550134', 'Ann  Marie', ' Ann', '@ann', 'Ann😀']) {
    expect(await create(uid, 'users', uid, { uid, displayName: bad }), bad).toBe(403)
  }
  expect(await create(uid, 'users', uid, { uid, displayName: "Zoë O'Brien-Lee" })).toBe(200)
  // First update: a profile with no name yet.
  const u = await seedUser('Una', { displayName: null })
  expect(await patch(u.uid, `users/${u.uid}`, { displayName: 'www.example' })).toBe(403)
  expect(await patch(u.uid, `users/${u.uid}`, { displayName: 'Ann' })).toBe(200)
  // Then only updateDisplayName changes it.
  expect(await patch(u.uid, `users/${u.uid}`, { displayName: 'Other' })).toBe(403)
})

test('F-079: the first playDisplayName must be a name too', async () => {
  const a = await seedUser('Adam')
  expect(await create(a.uid, `users/${a.uid}/playProfile`, 'data', { uid: a.uid, playDisplayName: 'dm me @ember' })).toBe(403)
  expect(await create(a.uid, `users/${a.uid}/playProfile`, 'data', { uid: a.uid, playDisplayName: 'E' })).toBe(403)
  expect(await create(a.uid, `users/${a.uid}/playProfile`, 'data', { uid: a.uid, playDisplayName: 'Ember' })).toBe(200)
  // A Play profile created without a name gets its first one checked the same way.
  const b = await seedUser('Bella')
  expect(await create(b.uid, `users/${b.uid}/playProfile`, 'data', { uid: b.uid, playBio: 'hi' })).toBe(200)
  expect(await patch(b.uid, `users/${b.uid}/playProfile/data`, { playDisplayName: 'velvet.club' })).toBe(403)
  expect(await patch(b.uid, `users/${b.uid}/playProfile/data`, { playDisplayName: 'Velvet' })).toBe(200)
})

test('F-079: names in texts are sanitised — links, handles and numbers become "Someone", long names are cut', async () => {
  const { smsSafeName } = fnLib('smsName')
  expect(smsSafeName('Sam')).toBe('Sam')
  expect(smsSafeName('  Ann   Marie ')).toBe('Ann Marie')
  for (const n of ['bit.ly/x', 'zylove.app', '@sam', 'www sam', 'sam: hi', '5125550134']) expect(smsSafeName(n), n).toBe('Someone')
  expect(smsSafeName('Bartholomew Montgomery-Smythe')).toHaveLength(20)
  // nameFor (match and message texts) runs every name through it: the match
  // snapshot, the profile, and the Play name.
  const { nameFor } = fnLib('sms')
  const a = await seedUser('Ann', {}, { play: PLAY('Ember') })
  expect(await nameFor(a.uid, { [a.uid]: { displayName: 'go to evil.com' } }, 'spark')).toBe('Someone')
  expect(await nameFor(a.uid, undefined, 'spark')).toBe('Ann')
  await db.doc(`users/${a.uid}/playProfile/data`).update({ playDisplayName: 'snap: ember22' })
  expect(await nameFor(a.uid, undefined, 'play')).toBe('Someone')
})

test('F-079: playProfile/data is deleted through deletePlayProfile only, and the Play name lock survives a delete and re-create', async () => {
  const a = await seedUser('Adam', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ember') })
  // A recent name change.
  await db.doc(`users/${a.uid}/playProfile/data`).update({ playDisplayNameUpdatedAt: Timestamp.now() })
  expect(await rest(a.uid, `users/${a.uid}/playProfile/data`, { method: 'DELETE' })).toBe(403)
  await callAs(a.uid, 'deletePlayProfile')
  expect((await db.doc(`users/${a.uid}/playProfile/data`).get()).exists).toBe(false)
  expect((await internalDoc(a.uid)).playNameLock).toMatchObject({ name: 'Ember' })
  // Re-created: a new name is refused for 30 days; the same name is fine.
  expect(await create(a.uid, `users/${a.uid}/playProfile`, 'data', { uid: a.uid, playDisplayName: 'Blaze' })).toBe(403)
  expect(await create(a.uid, `users/${a.uid}/playProfile`, 'data', { uid: a.uid, playDisplayName: 'Ember' })).toBe(200)
  // …and updateDisplayName still counts the change from before the delete.
  expect(await errOf(callAs(a.uid, 'updateDisplayName', { mode: 'play', displayName: 'Blaze' }))).toMatch(/once every 30 days/)

  // A Play name never changed: deleting locks it from now, so delete and
  // re-create can't stand in for a name change.
  const b = await seedUser('Bella', { genderIdentity: 'woman', attractedTo: ['men'], intent: 'open', onboardingPath: 'both' }, { play: PLAY('Velvet') })
  await callAs(b.uid, 'deletePlayProfile')
  expect(await create(b.uid, `users/${b.uid}/playProfile`, 'data', { uid: b.uid, playDisplayName: 'Satin' })).toBe(403)
  // A lock older than 30 days no longer holds.
  await db.doc(`userInternal/${b.uid}`).update({ 'playNameLock.at': Timestamp.fromMillis(Date.now() - 31 * 864e5) })
  expect(await create(b.uid, `users/${b.uid}/playProfile`, 'data', { uid: b.uid, playDisplayName: 'Satin' })).toBe(200)
  // The Spark side is untouched.
  expect((await userDoc(b.uid)).displayName).toBe('Bella')
})

// ─── F-081: flagged photos stay in review ────────────────────────────────────

test('F-081: the owner cannot clear a content-flagged hold; deleting the profile keeps it; admin review still sees and decides it', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const u = await seedUser('Uma')
  const path = `photos/${u.uid}/spark/e2e-nsfw-1.jpg`
  await upload(path)
  await expect.poll(async () => ((await accountDoc(u.uid))?.pendingPhotoURLs ?? []).find((p) => p.url === path)?.reason?.exceeded?.length ?? 0, { timeout: 30000 }).toBeGreaterThan(0)
  const holds = await db.collection('photoHolds').where('uid', '==', u.uid).get()
  expect(holds.docs.map((d) => d.data())).toEqual([expect.objectContaining({ url: path, mode: 'spark', kind: 'content' })])
  // The owner's queue is the server's: no emptying it, no editing it.
  expect(await patch(u.uid, `users/${u.uid}/private/account`, { pendingPhotoURLs: [] })).toBe(403)
  // Deleting the Spark profile drops other holds of that mode (a missing
  // face, a moderation error) but keeps the content flag, file and all.
  const other = `photos/${u.uid}/spark/noface.jpg`
  const pending = (await accountDoc(u.uid)).pendingPhotoURLs
  await db.doc(`users/${u.uid}/private/account`).update({ pendingPhotoURLs: [...pending, { url: other, mode: 'spark', reason: { noFace: true }, approved: false }] })
  await callAs(u.uid, 'deleteModePhotos', { mode: 'spark' })
  expect((await accountDoc(u.uid)).pendingPhotoURLs.map((p) => p.url)).toEqual([path])
  expect(await fileExists(path)).toBe(true)
  // A list emptied anyway (as the old rule allowed): Photo review still lists
  // the hold, and the file stays.
  await db.doc(`users/${u.uid}/private/account`).update({ pendingPhotoURLs: [] })
  await new Promise((r) => setTimeout(r, 2000)) // photo cleanup runs on the change
  expect(await fileExists(path)).toBe(true)
  const { photos } = await callAs(admin.uid, 'listPendingPhotos')
  expect(photos.find((p) => p.url === path)).toMatchObject({ uid: u.uid, mode: 'spark', reason: expect.objectContaining({ exceeded: expect.any(Array) }) })
  // Rejected from the hold alone: the hold and the file go.
  expect((await callAs(admin.uid, 'reviewPendingPhoto', { targetUid: u.uid, photoUrl: path, action: 'reject' })).status).toBe('rejected')
  expect((await db.collection('photoHolds').where('uid', '==', u.uid).get()).size).toBe(0)
  await expect.poll(() => fileExists(path), { timeout: 20000 }).toBe(false)
  expect((await callAs(admin.uid, 'listPendingPhotos')).photos.some((p) => p.url === path)).toBe(false)
})

// ─── F-087: duplicate photos ─────────────────────────────────────────────────

test('F-087: a duplicate photo counts against the newer uploader only, and alone never opens a trust flag', async () => {
  const a = await seedUser('Ann')
  const b = await seedUser('Abe')
  const pa = `photos/${a.uid}/spark/e2e-clean-own.jpg`
  const pb = `photos/${b.uid}/spark/e2e-clean-copy.jpg`
  await upload(pa)
  await expect.poll(async () => (await userDoc(a.uid)).photoURLs?.includes(pa) ?? false, { timeout: 30000 }).toBe(true)
  await upload(pb)
  const pairId = [a.uid, b.uid].sort().join('__')
  await expect.poll(async () => (await db.doc(`photoDuplicates/${pairId}`).get()).data()?.photos?.[0]?.newer ?? null, { timeout: 30000 }).toBe(b.uid)
  // B (the copy) carries the signal, A (who had it first) doesn't.
  await expect.poll(async () => (await db.doc(`behaviorSignals/${b.uid}`).get()).data()?.duplicatePhotos?.accounts ?? 0, { timeout: 20000 }).toBe(1)
  expect((await db.doc(`behaviorSignals/${a.uid}`).get()).data()?.duplicatePhotos).toBeUndefined()
  // Scored at 25 — under FLAG_AT (40) — so no flag opens and no admin is texted.
  await expect.poll(async () => (await db.doc(`trustProfiles/${b.uid}`).get()).data()?.reasons?.find((r) => r.key === 'duplicate_photo')?.points ?? 0, { timeout: 20000 }).toBe(25)
  expect((await db.doc(`trustProfiles/${b.uid}`).get()).data().score).toBeLessThan(40)
  await new Promise((r) => setTimeout(r, 1500))
  for (const u of [a, b]) expect((await db.doc(`trustFlags/${u.uid}`).get()).exists).toBe(false)
})
