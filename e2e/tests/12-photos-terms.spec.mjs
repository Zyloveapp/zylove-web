import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { resetEmulators, seedUser, callAs, idTokenFor, db, userDoc, accountDoc, FieldValue, PROJECT, PHOTO, FIXTURE } from './helpers.mjs'
import { migratePhotos } from '../../scripts/lib/stage1b.mjs'
import { planSweep, applySweep, deleteSwept, countTokens } from '../../scripts/lib/tokenSweep.mjs'

const require = createRequire(import.meta.url)
const { getStorage } = require('firebase-admin/storage')
const BUCKET = 'demo-zylove.appspot.com'
const bucket = () => getStorage().bucket(BUCKET)
// A real image: the server now rejects malformed files (Stage B metadata strip).
const PNG = require('node:fs').readFileSync(FIXTURE)

test.beforeEach(resetEmulators)

// Uploads as the server would see a client upload, then waits for
// onPhotoUpload's verdict (Sightengine is unreachable here, so: pending).
async function uploadPending(uid, mode, name) {
  const path = `photos/${uid}/${mode}/${name}`
  await bucket().file(path).save(PNG, { contentType: 'image/png' })
  await expect.poll(async () => ((await accountDoc(uid))?.pendingPhotoURLs ?? []).some((p) => p.url === path), { timeout: 30000 }).toBe(true)
  return path
}
const urlsFor = async (uid, refs) => (await callAs(uid, 'getPhotoUrls', { refs })).urls

// Storage emulator REST with a user's ID token: the Storage rules apply.
const SBASE = `http://127.0.0.1:9909/v0/b/${BUCKET}/o`
async function storageGet(uid, path) {
  return (await fetch(`${SBASE}/${encodeURIComponent(path)}?alt=media`, { headers: { Authorization: `Firebase ${await idTokenFor(uid)}` } })).status
}
// The same multipart upload the Firebase web SDK sends.
async function storageUpload(uid, path, metadata) {
  const boundary = 'b' + Math.random().toString(36).slice(2)
  const meta = JSON.stringify({ name: path, contentType: 'image/png', ...(metadata && { metadata }) })
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  return (await fetch(`${SBASE}?name=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { Authorization: `Firebase ${await idTokenFor(uid)}`, 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })).status
}
const FBASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`
async function restPatch(uid, path, fields) {
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join('&')
  return (await fetch(`${FBASE}/${path}?${mask}`, { method: 'PATCH', headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) })).status
}
const strArray = (xs) => ({ arrayValue: { values: xs.map((x) => ({ stringValue: x })) } })

test('photos: stored as paths; pending visible to owner and admins only; published to others; blocks and suspension hide them', async () => {
  const a = await seedUser('Ann')
  const b = await seedUser('Ben')
  const admin = await seedUser('Kim', { isAdmin: true })
  const ref = await uploadPending(a.uid, 'spark', 'one.png')
  expect((await userDoc(a.uid)).photoURLs).toEqual([PHOTO]) // not published

  expect(Object.keys(await urlsFor(a.uid, [ref]))).toEqual([ref]) // owner
  expect(await urlsFor(b.uid, [ref])).toEqual({}) // in review: nobody else
  expect(Object.keys(await urlsFor(admin.uid, [ref]))).toEqual([ref])

  await callAs(admin.uid, 'reviewPendingPhoto', { targetUid: a.uid, photoUrl: ref, action: 'approve' })
  expect((await userDoc(a.uid)).photoURLs).toContain(ref)
  const url = (await urlsFor(b.uid, [ref]))[ref]
  expect(url).toMatch(/X-Goog-Signature=/)
  expect(url).toMatch(/X-Goog-Expires=(\d+)/)
  expect(Number(/X-Goog-Expires=(\d+)/.exec(url)[1])).toBeLessThanOrEqual(7200)

  await db.doc(`users/${a.uid}/blockedUsers/${b.uid}`).set({ blockedAt: Date.now() })
  expect(await urlsFor(b.uid, [ref])).toEqual({})
  await db.doc(`users/${a.uid}/blockedUsers/${b.uid}`).delete()
  await db.doc(`userInternal/${a.uid}`).set({ isSuspended: true }, { merge: true }) // server-only (Stage 3)
  expect(await urlsFor(b.uid, [ref])).toEqual({})
  await expect(callAs(b.uid, 'getPhotoUrls', { refs: ['https://evil.example/x.png'] })).rejects.toThrow(/invalid-argument|INVALID_ARGUMENT/)
})

test('photos (F-031): a Play photo in review goes to the owner-only account doc, not playProfile', async () => {
  const a = await seedUser('Cleo', {}, { play: { name: 'C', photoURLs: [PHOTO] } })
  const ref = await uploadPending(a.uid, 'play', 'p1.png')
  expect((await accountDoc(a.uid)).pendingPhotoURLs.find((p) => p.url === ref)).toMatchObject({ mode: 'play', approved: false })
  expect((await db.doc(`users/${a.uid}/playProfile/data`).get()).data().pendingPhotoURLs).toBeUndefined()
  const admin = await seedUser('Kai', { isAdmin: true })
  await callAs(admin.uid, 'reviewPendingPhoto', { targetUid: a.uid, photoUrl: ref, action: 'approve' })
  expect((await db.doc(`users/${a.uid}/playProfile/data`).get()).data().photoURLs).toContain(ref)
  expect((await userDoc(a.uid)).photoURLs).not.toContain(ref) // Play stays Play
})

test('storage rules: no client reads photo files directly (signed URLs only); no overwrites; no server-only metadata', async () => {
  const a = await seedUser('Dov')
  const b = await seedUser('Eli')
  const admin = await seedUser('Ivy', { isAdmin: true })
  const path = `photos/${a.uid}/spark/file.png`
  await bucket().file(path).save(PNG, { contentType: 'image/png', metadata: { metadata: { zyloveCopy: '1' } } }) // no moderation run
  // Read access would let a client mint a permanent token link (getDownloadURL).
  expect(await storageGet(b.uid, path)).toBe(403)
  expect(await storageGet(a.uid, path)).toBe(403)
  expect(await storageGet(admin.uid, path)).toBe(403)
  expect(await storageUpload(a.uid, path)).toBe(403) // overwrite
  expect(await storageUpload(a.uid, `photos/${a.uid}/spark/copy.png`, { zyloveCopy: '1' })).toBe(403)
  expect(await storageUpload(b.uid, `photos/${a.uid}/spark/theirs.png`)).toBe(403)
  expect(await storageUpload(a.uid, `photos/${a.uid}/spark/new.png`)).toBe(200)
})

test('firestore rules: clients can remove or reorder published photos, never add one', async () => {
  const a = await seedUser('Fox', { photoURLs: [PHOTO, `photos/x/spark/a.png`] }, { play: { name: 'F', photoURLs: [PHOTO] } })
  expect(await restPatch(a.uid, `users/${a.uid}`, { photoURLs: strArray([PHOTO, `photos/${a.uid}/spark/unmoderated.png`]) })).toBe(403)
  expect(await restPatch(a.uid, `users/${a.uid}`, { photoURLs: strArray([`photos/x/spark/a.png`, PHOTO]) })).toBe(200) // reorder
  expect(await restPatch(a.uid, `users/${a.uid}`, { photoURLs: strArray([PHOTO]) })).toBe(200) // remove
  expect(await restPatch(a.uid, `users/${a.uid}/playProfile/data`, { photoURLs: strArray([PHOTO, `photos/${a.uid}/play/x.png`]) })).toBe(403)
  expect(await restPatch(a.uid, `users/${a.uid}/playProfile/data`, { pendingPhotoURLs: { arrayValue: { values: [] } } })).toBe(403)
})

test('migration 1b: photos move to new names, links become paths everywhere, old objects gone, no re-moderation', async () => {
  const a = await seedUser('Gil', {}, { play: { name: 'G', photoURLs: [] } })
  const b = await seedUser('Hana')
  const old = `photos/${a.uid}/spark/old.png`
  const oldPlay = `photos/${a.uid}/play/pending.png`
  for (const p of [old, oldPlay]) {
    await bucket().file(p).save(PNG, { contentType: 'image/png', metadata: { metadata: { zyloveCopy: '1', firebaseStorageDownloadTokens: 'leaked-token' } } })
    await bucket().file(p).setMetadata({ metadata: { zyloveCopy: null } }) // an ordinary original again
  }
  const signed = `https://storage.googleapis.com/${BUCKET}/${old}?GoogleAccessId=x&Expires=16725225600&Signature=abc`
  const tokenUrl = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(old)}?alt=media&token=leaked-token`
  await db.doc(`users/${a.uid}`).update({ photoURLs: [signed] })
  await db.doc(`users/${a.uid}/playProfile/data`).update({ pendingPhotoURLs: [{ url: tokenUrl.replace(encodeURIComponent(old), encodeURIComponent(oldPlay)), mode: 'play', approved: false }] })
  await db.doc(`users/${b.uid}/likeQueue/${a.uid}`).set({ likerProfile: { photoURL: signed, photoURLs: [tokenUrl] } })
  await db.doc('matches/m1').set({ users: [a.uid, b.uid], participantSnapshots: { [a.uid]: { photoURL: tokenUrl }, [b.uid]: { photoURL: PHOTO } } })

  const { moves } = await migratePhotos({ db, bucket: bucket(), FieldValue })
  expect(moves).toHaveLength(2)
  const newSpark = moves.find((m) => m.from === old).to
  const newPlay = moves.find((m) => m.from === oldPlay).to
  expect((await bucket().file(old).exists())[0]).toBe(false)
  const [meta] = await bucket().file(newSpark).getMetadata()
  expect(meta.metadata?.firebaseStorageDownloadTokens).toBeUndefined()
  expect((await userDoc(a.uid)).photoURLs).toEqual([newSpark])
  expect((await db.doc(`users/${b.uid}/likeQueue/${a.uid}`).get()).data().likerProfile).toEqual({ photoURL: newSpark, photoURLs: [newSpark] })
  expect((await db.doc('matches/m1').get()).data().participantSnapshots).toEqual({ [a.uid]: { photoURL: newSpark }, [b.uid]: { photoURL: PHOTO } })
  expect((await accountDoc(a.uid)).pendingPhotoURLs).toEqual([{ url: newPlay, mode: 'play', approved: false }])
  expect((await db.doc(`users/${a.uid}/playProfile/data`).get()).data().pendingPhotoURLs).toBeUndefined()
  // The copies weren't moderated again (no extra pending entries).
  await new Promise((r) => setTimeout(r, 4000))
  expect((await accountDoc(a.uid)).pendingPhotoURLs).toHaveLength(1)
  expect((await userDoc(a.uid)).photoURLs).toEqual([newSpark])
  // A second run finds nothing.
  expect((await migratePhotos({ db, bucket: bucket(), FieldValue })).moves).toHaveLength(0)
})

test('terms (F-024): recorded server-side with versions and IP; incomplete consents refused; clients cannot write', async () => {
  const a = await seedUser('Ivo')
  await expect(callAs(a.uid, 'recordTermsAcceptance', { consents: ['terms', 'privacy'] })).rejects.toThrow(/invalid-argument|INVALID_ARGUMENT/)
  const r = await callAs(a.uid, 'recordTermsAcceptance', { consents: ['age', 'terms', 'privacy', 'matching', 'conduct', 'safety'] })
  expect(r.versions).toEqual({ terms: '2026-10-07.2', privacy: '2026-10-07.2' })
  const main = (await db.doc(`users/${a.uid}/legalAcceptance/main`).get()).data()
  expect(main).toMatchObject({ uid: a.uid, termsVersion: '2026-10-07.2', privacyVersion: '2026-10-07.2', source: 'web' })
  expect(main.acceptedAt).toBeTruthy()
  expect('ip' in main).toBe(true) // null in the emulator (no client address); set in production by Cloud Run's X-Forwarded-For
  expect((await db.collection(`users/${a.uid}/legalAcceptance`).get()).size).toBe(2) // latest + history
  expect(await restPatch(a.uid, `users/${a.uid}/legalAcceptance/main`, { termsVersion: { stringValue: 'forged' } })).toBe(403)
})

test('review PDFs (F-033): owner gets a short-lived signed URL; others refused; no direct reads', async () => {
  const a = await seedUser('Jules')
  const b = await seedUser('Kit')
  const pdf = `reviews/${a.uid}/spark/r1.pdf`
  await bucket().file(pdf).save(Buffer.from('%PDF-1.4'), { contentType: 'application/pdf' })
  const { url } = await callAs(a.uid, 'getReviewPdfUrl', { pdfPath: pdf })
  expect(url).toMatch(/X-Goog-Signature=/)
  expect(Number(/X-Goog-Expires=(\d+)/.exec(url)[1])).toBeLessThanOrEqual(900)
  await expect(callAs(b.uid, 'getReviewPdfUrl', { pdfPath: pdf })).rejects.toThrow(/permission-denied|PERMISSION_DENIED/)
  await expect(callAs(a.uid, 'getReviewPdfUrl', { pdfPath: 'photos/x/spark/y.png' })).rejects.toThrow(/invalid-argument|INVALID_ARGUMENT/)
  await expect(callAs(a.uid, 'getReviewPdfUrl', { pdfPath: `reviews/${a.uid}/spark/missing.pdf` })).rejects.toThrow(/not-found|NOT_FOUND/)
  expect(await storageGet(a.uid, pdf)).toBe(403)
})

test('token sweep: bot and mobile-era photos move into the model, unreferenced ones go, review PDFs lose tokens — zero tokens left', async () => {
  const human = await seedUser('Lux')
  const bot = 'zbot-sweep-1'
  const tok = (path) => `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=t`
  const save = (path, ct = 'image/png') => bucket().file(path).save(PNG, { contentType: ct, metadata: { metadata: { firebaseStorageDownloadTokens: 't', zyloveCopy: '1' } } })
    .then(() => bucket().file(path).setMetadata({ metadata: { zyloveCopy: null } }))
  await save(`bot-photos/${bot}/0.png`)
  await save(`users/${human.uid}/photos/old.png`)
  await save(`users/${human.uid}/photos/unused.png`)
  await save(`reviews/${human.uid}/spark/r.pdf`, 'application/pdf')
  await db.doc(`users/${bot}`).set({ uid: bot, isBot: true, photoURLs: [tok(`bot-photos/${bot}/0.png`)], isSuspended: false })
  await db.doc(`users/${bot}/playProfile/data`).set({ photoURLs: [tok(`bot-photos/${bot}/0.png`)] })
  await db.doc(`users/${human.uid}`).update({ photoURLs: [tok(`users/${human.uid}/photos/old.png`)] })
  await db.doc(`users/${human.uid}/likeQueue/${bot}`).set({ likerProfile: { photoURL: tok(`bot-photos/${bot}/0.png`) } })

  const plan = await planSweep(db, bucket())
  expect(plan.moves.map((m) => m.from).sort()).toEqual([`bot-photos/${bot}/0.png`, `users/${human.uid}/photos/old.png`].sort())
  expect(plan.deletes).toEqual([`users/${human.uid}/photos/unused.png`])
  expect(plan.strips).toEqual([`reviews/${human.uid}/spark/r.pdf`])
  await applySweep({ db, bucket: bucket(), FieldValue }, plan)
  const botRef = plan.map.get(`bot-photos/${bot}/0.png`)
  expect(botRef).toMatch(new RegExp(`^photos/${bot}/spark/`))
  expect((await db.doc(`users/${bot}`).get()).data().photoURLs).toEqual([botRef])
  expect((await db.doc(`users/${bot}/playProfile/data`).get()).data().photoURLs).toEqual([botRef])
  expect((await db.doc(`users/${human.uid}/likeQueue/${bot}`).get()).data().likerProfile.photoURL).toBe(botRef)
  // The moved bot photo displays to another user through getPhotoUrls (published on the bot's root doc).
  expect(Object.keys(await urlsFor(human.uid, [botRef]))).toEqual([botRef])
  await deleteSwept(bucket(), plan)
  expect((await bucket().file(`bot-photos/${bot}/0.png`).exists())[0]).toBe(false)
  expect((await bucket().file(`users/${human.uid}/photos/unused.png`).exists())[0]).toBe(false)
  expect((await bucket().file(`reviews/${human.uid}/spark/r.pdf`).exists())[0]).toBe(true)
  expect((await countTokens(bucket())).withToken).toEqual([])
})
