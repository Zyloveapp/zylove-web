import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, CONTEXT, db, adminAuth, callAs, userDoc, Timestamp } from './helpers.mjs'

test.beforeEach(resetEmulators)

// The scheduled jobs (no Pub/Sub emulator): run the web codebase's compiled
// handlers directly against the emulator, through its own firebase-admin.
const WEB_FN = new URL('../web-fn/', import.meta.url).pathname // synced, shimmed copy of the web build
const fnRequire = createRequire(`${WEB_FN}package.json`)
function scheduled() {
  const app = fnRequire('firebase-admin/app')
  if (!app.getApps().length) app.initializeApp({ projectId: 'demo-zylove', storageBucket: 'demo-zylove.appspot.com' })
  return fnRequire(`${WEB_FN}lib/legacy/onNightlyPurge.js`)
}

test('deletion: delete account from Settings → soft-deleted, recovery doc, auth user removed; restore on return', async ({ browser }) => {
  const me = await seedUser('Rowan')
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const net = await offline(page)
  await quietFirstRun(page, me.uid)
  await signIn(page, me.phone, { expectPath: /\/discover/ })
  await page.goto('/settings')
  await page.getByText('Delete account', { exact: true }).click()
  await expect(page.getByText('Delete your account?')).toBeVisible()
  await page.getByRole('textbox').last().fill('DELETE')
  await page.getByRole('button', { name: 'Delete my account' }).click()
  await page.waitForURL(/\/login/, { timeout: 30000 })

  await expect(adminAuth.getUser(me.uid)).rejects.toThrow()
  expect((await db.doc(`deletedAccounts/${me.phone}`).get()).exists).toBe(true)
  const gone = await userDoc(me.uid)
  expect(gone.isDeleted).toBe(true)

  // Same phone signs up again → eligible to restore within 90 days → restored.
  await signIn(page, me.phone, { expectPath: /\/onboarding/ })
  const newUid = (await adminAuth.getUserByPhoneNumber(me.phone)).uid
  expect(newUid).not.toBe(me.uid)
  const elig = await callAs(newUid, 'checkRestoreEligibility')
  expect(elig.status).toBe('hard_block')
  await callAs(newUid, 'restoreAccount', { birthday: '1995-03-14' }) // F-086: the old birthday, typed
  const restored = await userDoc(newUid)
  expect(restored.displayName).toBe('Rowan')
  // F-028: the phone and birthday stay off the public doc.
  expect(restored.phoneNumber).toBeUndefined()
  expect(restored.birthday).toBeUndefined()
  expect((await db.doc(`users/${newUid}/private/identity`).get()).data()?.birthday).toBe('1995-03-14')
  // §4.A2: gender comes back owner-only; the public doc has only the line.
  expect(restored.genderIdentity).toBeUndefined()
  expect(restored.genderLine).toBe('')
  expect((await db.doc(`users/${newUid}/private/matching`).get()).data()?.genderIdentity).toBe('man')
  expect(old?.genderIdentity).toBeUndefined()
  // F-029: the deleted account's public doc kept nothing private.
  const old = await userDoc(me.uid)
  for (const f of ['birthday', 'locationLat', 'subscriptionTier', 'reportCount', 'smsNotificationsEnabled']) expect(old?.[f]).toBeUndefined()
  expect((await db.doc(`deletedAccounts/${me.phone}`).get()).exists).toBe(false)
  expect(net.errors).toEqual([])
  await ctx.close()
})

test('deletion: request → pending + hidden; cancel → request removed', async () => {
  const a = await seedUser('Sage')
  const r = await callAs(a.uid, 'requestAccountDeletion')
  expect(r.success).toBe(true)
  expect((await db.doc(`deletionRequests/${a.uid}`).get()).data()?.status).toBe('pending')
  const u = await userDoc(a.uid)
  expect(u.isSuspended).toBeUndefined() // server-only (Stage 3)
  expect((await db.doc(`userInternal/${a.uid}`).get()).data()).toMatchObject({ isSuspended: true })
  expect(u.sparkVisibility).toBe('hidden')
  await callAs(a.uid, 'cancelAccountDeletion')
  expect((await db.doc(`deletionRequests/${a.uid}`).get()).exists).toBe(false)
})

// B-002 regression: requestAccountDeletion stores scheduledFor as a
// Timestamp, so the grace job finds and processes it once it's due.
test('deletion: grace period expires → request processed (B-002)', async () => {
  const b = await seedUser('Tatum')
  await callAs(b.uid, 'requestAccountDeletion')
  const req = (await db.doc(`deletionRequests/${b.uid}`).get()).data()
  expect(req.scheduledFor).toBeInstanceOf(Timestamp)
  expect(req.scheduledFor.toMillis()).toBeGreaterThan(Date.now())
  // Not due yet: the job leaves it alone.
  await scheduled().processGraceExpiredDeletions.run({})
  expect((await db.doc(`deletionRequests/${b.uid}`).get()).data()?.status).toBe('pending')
  // Due: processed, account soft-deleted, auth user removed.
  await db.doc(`deletionRequests/${b.uid}`).update({ scheduledFor: Timestamp.fromMillis(Date.now() - 1000) })
  await scheduled().processGraceExpiredDeletions.run({})
  expect((await db.doc(`deletionRequests/${b.uid}`).get()).data()?.status).toBe('processed')
  await expect(adminAuth.getUser(b.uid)).rejects.toThrow()
  expect((await userDoc(b.uid)).isDeleted).toBe(true)
})

test('deletion: nightly purge hard-deletes accounts soft-deleted over 12 months ago', async () => {
  const old = await seedUser('Uma', { isDeleted: true, deletedAt: Timestamp.fromMillis(Date.now() - 400 * 86400000) })
  const recent = await seedUser('Vic', { isDeleted: true, deletedAt: Timestamp.fromMillis(Date.now() - 10 * 86400000) })
  await scheduled().onNightlyPurge.run({})
  expect((await db.doc(`users/${old.uid}`).get()).exists).toBe(false)
  expect((await db.doc(`users/${recent.uid}`).get()).exists).toBe(true)
})
