import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, callAs, likeAs, db, sortedPair, userDoc, internalDoc, accountDoc, LEGACY, Timestamp , FIXTURE, fnLib } from './helpers.mjs'

test.beforeEach(resetEmulators)

test('claimWomenElite: woman → elite; man → not eligible; idempotent', async () => {
  const w = await seedUser('Wren', { genderIdentity: 'woman', attractedTo: ['men'], subscriptionTier: 'free' })
  const m = await seedUser('Xan')
  // Stage C: Elite by identity is the server's entitlement; the call writes
  // nothing (a stored subscriptionTier would outlive the identity).
  expect(await callAs(w.uid, 'claimWomenElite')).toMatchObject({ success: true, alreadyElite: true })
  expect((await internalDoc(w.uid)).subscriptionTier).toBe('free')
  await fnLib('playAccess').refreshPlayAccess(w.uid)
  expect((await internalDoc(w.uid)).entitlement).toMatchObject({ tier: 'elite', source: 'identity' })
  await expect.poll(async () => (await accountDoc(w.uid))?.entitlement?.tier, { timeout: 15000 }).toBe('elite') // the app's copy
  expect(await callAs(w.uid, 'claimWomenElite')).toMatchObject({ success: true, alreadyElite: true })
  expect(await callAs(m.uid, 'claimWomenElite')).toMatchObject({ success: false, error: 'not_eligible' })
  expect(LEGACY ? (await userDoc(m.uid)).subscriptionTier : (await internalDoc(m.uid)).subscriptionTier).toBe('free')
})

test('onProfileWrite: a profile change rescores that user\'s pairs', async () => {
  const a = await seedUser('Yael', { genderIdentity: 'woman', attractedTo: ['men'], profileUpdatedAt: Timestamp.fromMillis(Date.now() - 60000) })
  const b = await seedUser('Zed')
  await likeAs(a.uid, b.uid) // onTap creates the scored pair
  const ref = db.doc(`pairs/${sortedPair(a.uid, b.uid)}`)
  // Let the like's async triggers (onCompatibilityPopup, onLikesReceived…)
  // finish touching the pair before measuring.
  const stamp = async () => (await ref.get()).data().scoreCalculatedAt.toMillis()
  for (let last = -1, cur = await stamp(); cur !== last; ) { last = cur; await new Promise((r) => setTimeout(r, 2000)); cur = await stamp() }
  const before = (await ref.get()).data()
  expect(typeof before.sparkScore).toBe('number')
  // An update that doesn't touch profileUpdatedAt doesn't rescore…
  await db.doc(`users/${a.uid}`).update({ bio: 'changed without profileUpdatedAt' })
  await new Promise((r) => setTimeout(r, 2500))
  expect((await ref.get()).data().scoreCalculatedAt.toMillis()).toBe(before.scoreCalculatedAt.toMillis())
  // …a profile edit does.
  await db.doc(`users/${a.uid}`).update({ lifestyleTags: ['adventurer'], profileUpdatedAt: Timestamp.now() })
  await expect.poll(async () => (await ref.get()).data().scoreCalculatedAt.toMillis(), { timeout: 20000 }).toBeGreaterThan(before.scoreCalculatedAt.toMillis())
  const after = (await ref.get()).data()
  expect(typeof after.sparkScore).toBe('number')
  // Stage 2: no Play scores on the pair doc; and neither has Play, so none at all.
  expect(after.playScore).toBeUndefined()
  expect((await db.doc(`pairs/${sortedPair(a.uid, b.uid)}/modes/play`).get()).exists).toBe(false)
})

test('onPhotoUpload: moderation failure routes the photo to pending review', async () => {
  // Covered end to end by the onboarding tests (Storage upload → onPhotoUpload
  // → pendingPhotoURLs). Here: the pending entry's shape.
  const u = await seedUser('Ari', { photoURLs: [] })
  const { getStorage } = await import('./helpers.mjs').then(() => import('firebase-admin/storage'))
  await getStorage().bucket('demo-zylove.appspot.com').file(`photos/${u.uid}/spark/test.png`).save((await import('node:fs')).readFileSync(FIXTURE), { contentType: 'image/png' })
  await expect.poll(async () => (await accountDoc(u.uid))?.pendingPhotoURLs?.length ?? 0, { timeout: 30000 }).toBe(1)
  const d = await userDoc(u.uid)
  expect((await internalDoc(u.uid)).hasPendingPhotos).toBe(true)
  expect((await accountDoc(u.uid)).pendingPhotoURLs[0]).toMatchObject({ mode: 'spark', approved: false })
  expect(d.pendingPhotoURLs).toBeUndefined()
  expect(d.photoURLs).toEqual([])
})
