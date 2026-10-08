// Trust & Safety Phase 5 (2026-10): duplicate photos — perceptual hashes on
// every profile photo upload; the same photo on two accounts flags both for
// review (never rejected); a banned scammer's photos form a blocklist that
// holds matching uploads for review; lifting the ban removes them; a deleted
// photo's hash goes with it.
import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, callAs, db, fnLib, idTokenFor, userDoc, accountDoc, APP, CONTEXT, offline, quietFirstRun, signIn } from './helpers.mjs'

test.beforeEach(resetEmulators)

const BUCKET = 'demo-zylove.appspot.com'
const JPEG = (await import('node:fs')).readFileSync(new URL('../fixture.jpg', import.meta.url))
async function upload(uid, path) {
  const boundary = 'b' + Math.random().toString(36).slice(2)
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ name: path, contentType: 'image/jpeg' })}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`),
    JPEG,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  const status = (await fetch(`http://127.0.0.1:9909/v0/b/${BUCKET}/o?name=${encodeURIComponent(path)}`, {
    method: 'POST', headers: { Authorization: `Firebase ${await idTokenFor(uid)}`, 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).status
  expect(status).toBe(200)
}
const hashOf = async (path) => (await db.collection('photoHashes').where('path', '==', path).get()).docs[0]?.data()
const published = (uid, path) => expect.poll(async () => (await userDoc(uid)).photoURLs?.includes(path) ?? false, { timeout: 30000 }).toBe(true)
const signals = async (uid) => (await db.doc(`behaviorSignals/${uid}`).get()).data() ?? {}
const flag = async (uid) => (await db.doc(`trustFlags/${uid}`).get()).data()

test('duplicates: the same photo on two accounts flags both, side by side; one account reusing its own photo is not a match; nothing is rejected', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const a = await seedUser('Ann')
  const b = await seedUser('Abe')
  const pa1 = `photos/${a.uid}/spark/e2e-clean-a1.jpg`
  const pa2 = `photos/${a.uid}/spark/e2e-clean-a2.jpg` // same bytes, same account
  const pb = `photos/${b.uid}/spark/e2e-clean-b1.jpg`
  await upload(a.uid, pa1)
  await published(a.uid, pa1)
  await upload(a.uid, pa2)
  await published(a.uid, pa2)
  await expect.poll(async () => (await hashOf(pa2))?.hash ?? null, { timeout: 30000 }).toBe((await hashOf(pa1)).hash)
  expect((await db.collection('photoDuplicates').get()).size).toBe(0) // own reuse isn't a match
  expect((await hashOf(pa1)).hash).toMatch(/^[a-f0-9]{16}$/)
  expect((await hashOf(pa1)).bands).toHaveLength(4)

  await upload(b.uid, pb)
  await published(b.uid, pb) // never rejected
  const pairId = [a.uid, b.uid].sort().join('__')
  await expect.poll(async () => (await db.doc(`photoDuplicates/${pairId}`).get()).data()?.status, { timeout: 30000 }).toBe('open')
  const pair = (await db.doc(`photoDuplicates/${pairId}`).get()).data()
  expect(pair).toMatchObject({ uids: [a.uid, b.uid].sort(), distance: 0 })
  expect(pair.photos.some((p) => p[b.uid] === pb && [pa1, pa2].includes(p[a.uid]))).toBe(true)
  for (const u of [a, b]) {
    await expect.poll(async () => (await signals(u.uid)).duplicatePhotos?.accounts ?? 0, { timeout: 20000 }).toBe(1)
    await expect.poll(async () => (await flag(u.uid))?.reasons?.[0]?.key, { timeout: 20000 }).toBe('duplicate_photo')
  }
  expect((await flag(a.uid)).reasons[0].text).toMatch(/near-same photo as 1 other account/)
  // The dashboard shows both photos side by side (short-lived links).
  const d = await callAs(admin.uid, 'adminTrustDetail', { uid: a.uid })
  expect(d.duplicatePhotos).toHaveLength(1)
  expect(d.duplicatePhotos[0]).toMatchObject({ otherUid: b.uid, otherName: 'Abe', distance: 0 })
  expect(d.duplicatePhotos[0].photos[0].mine).toMatch(/^http/)
  expect(d.duplicatePhotos[0].photos[0].theirs).toMatch(/^http/)

  // Hashes aren't readable by anyone but the server.
  const r = await fetch(`http://127.0.0.1:8390/v1/projects/demo-zylove/databases/(default)/documents/photoHashes`, { headers: { Authorization: `Bearer ${await idTokenFor(a.uid)}` } })
  expect(r.status).toBe(403)

  // B's photo is deleted: its hash goes, and the pair with it.
  const { getStorage } = await import('firebase-admin/storage')
  fnLib('userData') // initialises the admin app for Storage
  await getStorage().bucket(BUCKET).file(pb).delete()
  await expect.poll(async () => (await hashOf(pb)) ?? null, { timeout: 30000 }).toBeNull()
  await expect.poll(async () => (await db.doc(`photoDuplicates/${pairId}`).get()).exists, { timeout: 30000 }).toBe(false)
  await expect.poll(async () => (await signals(b.uid)).duplicatePhotos ?? null, { timeout: 20000 }).toBeNull()
})

test('blocklist: a scam ban lists the photos; the same photo from a new account is held for review (not deleted) with the match\'s context; an ordinary ban doesn\'t list; lifting the ban removes them', async ({ browser }) => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const s = await seedUser('Sam')
  const ps = `photos/${s.uid}/spark/e2e-clean-s1.jpg`
  await upload(s.uid, ps)
  await published(s.uid, ps)
  await expect.poll(async () => (await hashOf(ps)) ?? null, { timeout: 30000 }).not.toBeNull()
  // The same photo again on Sam's account: two blocklist entries later ("and 1 more").
  const ps2 = `photos/${s.uid}/spark/e2e-clean-s2.jpg`
  await upload(s.uid, ps2)
  await published(s.uid, ps2)
  await expect.poll(async () => (await hashOf(ps2)) ?? null, { timeout: 30000 }).not.toBeNull()
  // Sam was reported for a scam twice and harassment once.
  const r1 = await seedUser('Rae')
  const r2 = await seedUser('Rex')
  await db.doc(`reports/${r1.uid}_${s.uid}_0`).set({ reporterUid: r1.uid, reportedUid: s.uid, categories: ['scam', 'harassment'], status: 'pending', createdAt: Date.now() })
  await db.doc(`reports/${r2.uid}_${s.uid}_0`).set({ reporterUid: r2.uid, reportedUid: s.uid, categories: ['scam'], status: 'pending', createdAt: Date.now() })

  // An ordinary ban (not for a scam): no blocklist.
  const o = await seedUser('Oli')
  const po = `photos/${o.uid}/spark/e2e-clean-o1.jpg`
  await upload(o.uid, po)
  await published(o.uid, po)
  await callAs(admin.uid, 'adminModerate', { uid: o.uid, action: 'ban', scam: false })
  expect((await db.collection('photoBlocklist').where('uid', '==', o.uid).get()).size).toBe(0)

  // A scam ban: Sam's photos go on the blocklist before the account is deleted.
  await callAs(admin.uid, 'adminModerate', { uid: s.uid, action: 'ban', scam: true })
  const listed = (await db.collection('photoBlocklist').where('uid', '==', s.uid).get()).docs.map((x) => x.data())
  expect(listed).toHaveLength(2)
  expect(listed.find((x) => x.path === ps)).toMatchObject({ by: admin.uid, hash: expect.stringMatching(/^[a-f0-9]{16}$/), name: 'Sam', adminMarkedScam: true, reports: { scam: 2, harassment: 1 } })
  expect((await userDoc(s.uid)).displayName).toBe('Deleted User') // the name was kept on the blocklist before this
  await expect.poll(async () => (await db.collection('photoHashes').where('uid', '==', s.uid).get()).size, { timeout: 30000 }).toBe(0)

  // A new account uploads the same photo: held from publishing, pending review.
  const n = await seedUser('Neo')
  const pn = `photos/${n.uid}/spark/e2e-clean-n1.jpg`
  await upload(n.uid, pn)
  await expect.poll(async () => ((await accountDoc(n.uid))?.pendingPhotoURLs ?? []).find((p) => p.url === pn)?.reason?.blocklist ?? false, { timeout: 30000 }).toBe(true)
  expect((await userDoc(n.uid)).photoURLs).not.toContain(pn)
  const { getStorage } = await import('firebase-admin/storage')
  fnLib('userData')
  expect((await getStorage().bucket(BUCKET).file(pn).exists())[0]).toBe(true) // not deleted
  await expect.poll(async () => (await flag(n.uid))?.reasons?.map((r) => r.key) ?? [], { timeout: 20000 }).toContain('blocklist_photo')

  // The hold carries the match's context, stored when it was held.
  const held = (await accountDoc(n.uid)).pendingPhotoURLs.find((p) => p.url === pn)
  expect(held.reason).toMatchObject({ blocklist: true, distance: 0, more: 1, match: { uid: s.uid, name: 'Sam', distance: 0, adminMarkedScam: true, reports: { scam: 2, harassment: 1 } } })
  expect(typeof held.reason.match.bannedAt).toBe('number')
  // Photo review shows it: which account, when and why banned, how close.
  const { photos } = await callAs(admin.uid, 'listPendingPhotos')
  const row = photos.find((p) => p.url === pn)
  expect(row.blocklistMatch).toMatchObject({
    uid: s.uid,
    name: 'Sam',
    closeness: 'Exact copy',
    distance: 0,
    more: 1,
    onRecord: true,
    why: 'Banned for a scam or fraud · scam reports: 2 · harassment reports: 1',
  })
  // No image of the banned account's is kept or shown: hashes only.
  expect(JSON.stringify(row.blocklistMatch)).not.toMatch(/photos\//)
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ ...CONTEXT, viewport })
    const page = await ctx.newPage()
    await offline(page)
    await quietFirstRun(page, admin.uid)
    await signIn(page, admin.phone, { expectPath: /\/discover/ })
    await page.goto(`${APP}/admin/photos`)
    const box = page.getByTestId('blocklist-match')
    await expect(box).toBeVisible({ timeout: 20000 })
    await expect(box).toContainText('Exact copy')
    await expect(box).toContainText('and 1 more')
    await expect(box).toContainText('Banned for a scam or fraud · scam reports: 2 · harassment reports: 1')
    await expect(box.getByRole('link', { name: 'Sam' })).toHaveAttribute('href', `/admin/trust?uid=${s.uid}`)
    // A second browser for the same admin: the chat-key notice can cover the page.
    const gotIt = page.getByRole('button', { name: 'Got it' })
    if (await gotIt.isVisible().catch(() => false)) await gotIt.click()
    await expect.poll(() => page.evaluate(() => { const i = document.querySelector('li img'); return !!i && !i.src.startsWith('data:') && i.complete && i.naturalWidth > 1 }), { timeout: 20000 }).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/admin-photos-blocklist-${viewport.width}.png`, fullPage: true })
    if (viewport.width === 1280) {
      // The link opens that account in the trust dashboard.
      await box.getByRole('link', { name: 'Sam' }).click()
      await expect(page).toHaveURL(new RegExp(`/admin/trust\\?uid=${s.uid}`))
      await expect(page.getByText(/Member since/)).toBeVisible({ timeout: 20000 })
    }
    await ctx.close()
  }

  // The ban is lifted: the photos leave the blocklist; the same photo now publishes.
  await callAs(admin.uid, 'adminModerate', { uid: s.uid, action: 'unban' })
  expect((await db.collection('photoBlocklist').where('uid', '==', s.uid).get()).size).toBe(0)
  expect((await db.collection('bannedPhones').where('uid', '==', s.uid).get()).size).toBe(0)
  const m = await seedUser('Max')
  const pm = `photos/${m.uid}/spark/e2e-clean-m1.jpg`
  await upload(m.uid, pm)
  await published(m.uid, pm)
})
