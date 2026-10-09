// Final review, stage 2 (accounts and retention): F-086 (recycled phone
// numbers — checkRestoreEligibility says only whether a restore is possible;
// restoreAccount needs the old birthday, 5 tries a day), F-085 (open trust
// flags of deleted accounts close; TTL backstops in purgeRetention), and the
// Terms update (§7.3: deleting cancels a paid plan; §8 chat PIN wording).
import { test, expect } from '@playwright/test'
import {
  resetEmulators, seedUser, callAs, db, adminAuth, fnLib, offline, quietFirstRun, signIn, CONTEXT, Timestamp, userDoc,
} from './helpers.mjs'

test.beforeEach(resetEmulators)

const errOf = (p) => p.then(() => null, (e) => String(e.message))
const ts = (v) => (v && typeof v.toMillis === 'function' ? Timestamp.fromMillis(v.toMillis()) : v)
const DAY = 24 * 60 * 60 * 1000

// An account deleted `daysAgo` days ago whose number now belongs to a new
// Auth user with no profile (the recycled-number case, or the owner back).
let nextPhone = 0
async function deletedAccountOnNewNumber(name, { daysAgo = 3 } = {}) {
  const old = await seedUser(name)
  const phone = `+1555019${String(9000 + ++nextPhone).slice(-4)}`
  const caller = `e2e-new-${name.toLowerCase()}-${nextPhone}`
  await adminAuth.createUser({ uid: caller, phoneNumber: phone })
  // (Timestamps rebuilt with this process's SDK; the record is otherwise as written.)
  const rec = await fnLib('userData').recoveryRecord(old.uid, (await db.doc(`users/${old.uid}`).get()).data(), phone)
  await db.doc(`deletedAccounts/${phone}`).set({
    ...rec,
    deletedAt: Timestamp.fromMillis(Date.now() - daysAgo * DAY),
    identityLockedAt: ts(rec.identityLockedAt),
    suspension: null,
  })
  return { old, phone, caller }
}

// ─── F-086: checkRestoreEligibility ───────────────────────────────────────────

test('F-086: checkRestoreEligibility says only whether a restore is possible — no name, photos, birthday or gender', async () => {
  const { caller } = await deletedAccountOnNewNumber('Olly')
  const r = await callAs(caller, 'checkRestoreEligibility')
  expect(r).toEqual({ status: 'hard_block', eligible: true })
  const raw = JSON.stringify(r)
  for (const leak of ['Olly', '1995', 'man', 'photo', 'birthday', 'pronouns', 'recoveryData']) expect(raw).not.toContain(leak)

  const aged = await deletedAccountOnNewNumber('Ada', { daysAgo: 120 })
  expect(await callAs(aged.caller, 'checkRestoreEligibility')).toEqual({ status: 'soft_block', eligible: false })

  const fresh = await seedUser('Fay')
  expect(await callAs(fresh.uid, 'checkRestoreEligibility')).toEqual({ status: 'clear', eligible: false })
})

// ─── F-086: restoreAccount needs the old birthday ─────────────────────────────

test('F-086: restore with a wrong or missing birthday fails generically; the right one restores', async () => {
  const { old, phone, caller } = await deletedAccountOnNewNumber('Rory')
  const wrong = await errOf(callAs(caller, 'restoreAccount', { birthday: '1990-01-01' }))
  expect(wrong).toMatch(/couldn't verify this account/)
  expect(wrong).not.toMatch(/birthday|1995/i)
  const missing = await errOf(callAs(caller, 'restoreAccount'))
  expect(missing).toBe(wrong)
  // Nothing restored, the record is still there.
  expect((await db.doc(`users/${caller}`).get()).exists).toBe(false)
  expect((await db.doc(`deletedAccounts/${phone}`).get()).exists).toBe(true)

  const ok = await callAs(caller, 'restoreAccount', { birthday: '1995-03-14' })
  expect(ok.success).toBe(true)
  const restored = await userDoc(caller)
  expect(restored.displayName).toBe('Rory')
  expect(restored.previousUid).toBe(old.uid)
  expect((await db.doc(`users/${caller}/private/identity`).get()).data()?.birthday).toBe('1995-03-14')
  expect((await db.doc(`deletedAccounts/${phone}`).get()).exists).toBe(false)
})

test('F-086: 5 birthday tries a day — the 6th is refused even when right, with the same answer', async () => {
  const { phone, caller } = await deletedAccountOnNewNumber('Tess')
  const first = await errOf(callAs(caller, 'restoreAccount', { birthday: '2000-01-01' }))
  expect(first).toMatch(/couldn't verify this account/)
  for (let i = 0; i < 4; i++) expect(await errOf(callAs(caller, 'restoreAccount', { birthday: `2000-01-0${i + 2}` }))).toBe(first)
  // Right birthday, over the limit: refused, indistinguishable from wrong.
  expect(await errOf(callAs(caller, 'restoreAccount', { birthday: '1995-03-14' }))).toBe(first)
  expect((await db.doc(`users/${caller}`).get()).exists).toBe(false)
  expect((await db.doc(`deletedAccounts/${phone}`).get()).exists).toBe(true)
})

// ─── F-085: retention ─────────────────────────────────────────────────────────

test('F-085: an open trust flag of a deleted account is closed and kept 2 years; a live account\'s stays open', async () => {
  const live = await seedUser('Lou')
  const open = (uid) => ({ uid, status: 'open', score: 60, reasons: [], openedAt: Timestamp.now(), expiresAt: null })
  await db.doc(`trustFlags/${live.uid}`).set(open(live.uid))
  await db.doc('trustFlags/e2e-gone-1').set(open('e2e-gone-1'))
  await fnLib('trustScore').computeTrustScores.run({})
  expect((await db.doc(`trustFlags/${live.uid}`).get()).data()?.status).toBe('open')
  const closed = (await db.doc('trustFlags/e2e-gone-1').get()).data()
  expect(closed).toMatchObject({ status: 'dismissed', closeAction: 'account_deleted', closedBy: 'system' })
  const left = closed.expiresAt.toMillis() - Date.now()
  expect(left).toBeGreaterThan(729 * DAY)
  expect(left).toBeLessThan(731 * DAY)
})

test('F-085: sign-in attempt windows and admin alerts older than 30 days are purged (TTL backstop)', async () => {
  const old = Timestamp.fromMillis(Date.now() - 40 * DAY)
  await db.doc('phoneVerificationAttempts/old').set({ count: 1, firstAttempt: old, expiresAt: old })
  await db.doc('phoneVerificationAttempts/new').set({ count: 1, firstAttempt: Timestamp.now(), expiresAt: Timestamp.now() })
  await db.doc('adminAlertQueue/old').set({ type: 'trustFlag', at: old, expiresAt: old })
  await db.doc('adminAlertQueue/new').set({ type: 'trustFlag', at: Timestamp.now(), expiresAt: Timestamp.now() })
  const r = fnLib('retention')
  for (const c of ['phoneVerificationAttempts', 'adminAlertQueue']) {
    const res = await r.purgeCollection(r.RETENTION.find((e) => e.collection === c), Date.now(), { dryRun: false })
    expect(res.deleted).toBe(1)
    expect((await db.doc(`${c}/old`).get()).exists).toBe(false)
    expect((await db.doc(`${c}/new`).get()).exists).toBe(true)
  }
})

// ─── Terms update (§7.3, §8) ──────────────────────────────────────────────────

test('Terms update: an existing user who accepted the previous Terms sees the notice, with the cancellation and chat PIN changes', async ({ browser }) => {
  const { LEGAL_VERSIONS } = fnLib('legal')
  expect(LEGAL_VERSIONS.terms).toBe('2026-10-08')
  const a = await seedUser('Ivy', {}, { legal: { terms: '2026-10-07.2', privacy: LEGAL_VERSIONS.privacy } })
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, a.uid)
  await signIn(page, a.phone, { expectPath: /\/discover/ })
  const notice = page.getByRole('dialog', { name: "We've updated our Terms" })
  await expect(notice).toBeVisible({ timeout: 20000 })
  await expect(notice.getByText(/the updated Terms apply/)).toBeVisible()
  await expect(notice.getByText(/Deleting your account also cancels a paid plan/)).toBeVisible()
  await expect(notice.getByText(/Chat PIN: the backup of your chat key/)).toBeVisible()
  await notice.getByRole('button', { name: 'Got it' }).click()
  await expect(notice).toBeHidden()
  await expect.poll(async () => (await db.doc(`users/${a.uid}/legalAcceptance/notice`).get()).data()?.termsVersion).toBe('2026-10-08')
  // The Terms page carries the new §7.3 sentence.
  await page.goto('/terms')
  await expect(page.getByText(/Deleting your account also cancels your subscription in the same way/)).toBeVisible()
  await ctx.close()
})
