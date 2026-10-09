// Shared helpers for the Zylove regression suite. Everything talks to the
// local emulators (demo-zylove); nothing reaches production.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
import { migrateUser } from '../../scripts/lib/stage1a.mjs'
import { migrateUserStage2 } from '../../scripts/lib/stage2.mjs'
import { migrateUserStage3 } from '../../scripts/lib/stage3.mjs'
import { migrateUserA2 } from '../../scripts/lib/a2gender.mjs'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8390'
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9409'
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9909'
process.env.GCLOUD_PROJECT = 'demo-zylove'

const require = createRequire(import.meta.url)
const { initializeApp, getApps } = require('firebase-admin/app')
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore')
const { getAuth } = require('firebase-admin/auth')
if (!getApps().length) initializeApp({ projectId: 'demo-zylove' })
export const db = getFirestore()
export const adminAuth = getAuth()
export { Timestamp, FieldValue }

// SEED_LEGACY=1: seeded users stay in the old (unmigrated) layout.
export const LEGACY = process.env.SEED_LEGACY === '1'
export const PROJECT = 'demo-zylove'
export const APP = 'http://localhost:5409'
export const AUSTIN = { latitude: 30.25, longitude: -97.75 }
export const PHOTO = 'https://e2e.invalid/photo.png'
export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixture.png')
const PNG = readFileSync(FIXTURE)

// ─── Emulator state ──────────────────────────────────────────────────────────

export async function resetEmulators() {
  await fetch(`http://127.0.0.1:8390/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  await fetch(`http://127.0.0.1:9409/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' })
  const { getStorage } = require('firebase-admin/storage')
  await getStorage().bucket('demo-zylove.appspot.com').deleteFiles({ force: true }).catch(() => {})
}

// The SMS code the Auth emulator "sent" to this number (latest one).
export async function smsCode(phone) {
  const r = await (await fetch(`http://127.0.0.1:9409/emulator/v1/projects/${PROJECT}/verificationCodes`)).json()
  const codes = (r.verificationCodes ?? []).filter((c) => c.phoneNumber === phone)
  return codes.at(-1)?.code ?? null
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

let seq = 0
export function phoneFor(n) {
  return `+1555010${String(1000 + n).slice(-4)}`
}

// An onboarded Spark user in Austin. Overrides merge into users/{uid}, in the
// old single-doc layout; the user is then migrated with the real Stage 1a
// migration (scripts/lib/stage1a.mjs) unless legacy: true.
// No publicKey: the browser that signs in generates and publishes one.
export async function seedUser(name, overrides = {}, { play = null, legacy = LEGACY, legal = 'current' } = {}) {
  const n = ++seq
  const uid = `e2e-${name.toLowerCase()}-${n}`
  const phone = phoneFor(n)
  await adminAuth.createUser({ uid, phoneNumber: phone })
  const now = Date.now()
  const doc = {
    uid,
    displayName: name,
    age: 30,
    birthday: '1995-03-14',
    genderIdentity: 'man',
    attractedTo: ['women'],
    openTo: ['monogamy'],
    relationshipStatus: 'single',
    intent: 'spark',
    ageMin: 21,
    ageMax: 45,
    radiusMiles: 25,
    heightCm: 178,
    bio: `Hi, I'm ${name}.`,
    promptAnswers: [
      { promptId: 'perfect_sunday', answer: 'Coffee and a long walk' },
      { promptId: 'green_flag', answer: 'Kindness' },
      { promptId: 'proud_of', answer: 'My garden' },
    ],
    lifestyleTags: ['outdoorsy'],
    personalityTraits: ['curious'],
    relationshipValues: ['honesty'],
    weekendVibes: ['outdoors'],
    loveLangGive: ['quality_time'],
    loveLangReceive: ['quality_time'],
    photoURLs: [PHOTO],
    sparkVisibility: 'active',
    playVisibility: play ? 'active' : 'hidden', // a seeded Play profile is visible in Play
    onboardingComplete: true,
    onboardingPath: 'spark',
    mode: 'spark',
    isSuspended: false,
    reportCount: 0,
    verificationStatus: 'phone_verified',
    subscriptionTier: 'free',
    sortKey: Math.random(),
    locationLat: 30.25,
    locationLng: -97.75,
    locationLabel: 'Austin, TX',
    createdAt: now,
    lastActive: now,
    identityLockedAt: Timestamp.now(),
    smsNotificationsEnabled: { spark: false, play: false },
    ...overrides,
  }
  await db.doc(`users/${uid}`).set(doc)
  if (!legacy) await migrateUser({ db, auth: adminAuth, FieldValue, Timestamp }, uid, doc)
  await db.doc(`users/${uid}/sparkProfile/data`).set({
    uid, displayName: name, age: doc.age, bio: doc.bio, isActive: true, completeness: 90, promptAnswers: doc.promptAnswers,
  })
  if (play) await db.doc(`users/${uid}/playProfile/data`).set({ uid, isActive: true, playOnboardingComplete: true, photoURLs: [PHOTO], ...play })
  // Stage 2: Play data and Play-revealing metadata off the public doc; Play flags.
  if (!legacy && process.env.SEED_STAGE2_LEGACY !== "1") await migrateUserStage2({ db, FieldValue }, uid)
  // Stage 3: preferences and account state off the public doc; then the Explore index entry.
  if (!legacy && process.env.SEED_STAGE3_LEGACY !== "1") await migrateUserStage3({ db, FieldValue }, uid)
  // §4.A2: gender off the public doc (Stage 3 already moved it with the
  // other matching fields); the public genderLine at once.
  if (!legacy && process.env.SEED_A2_LEGACY !== "1") await migrateUserA2({ db, FieldValue }, uid)
  await fnLib('explore').refreshEntry(uid)
  // F-062: the public Play profile (playProfiles/{playId}) at once, rather
  // than waiting on its trigger.
  if (play) await fnLib('playProfiles').refreshPlayProfile(uid)
  // Onboarded users accepted the Terms then in force; 'current' keeps the
  // legal-update notice away, null seeds no acceptance, or pass old versions.
  if (legal) {
    const v = legal === 'current' ? fnLib('legal').LEGAL_VERSIONS : legal
    await db.doc(`users/${uid}/legalAcceptance/main`).set({ uid, mode: 'main', termsVersion: v.terms, privacyVersion: v.privacy, source: 'e2e' })
  }
  return { uid, phone, name, doc }
}

// The web functions build (the synced emulator copy), initialised against
// the emulator in this process — for running server code directly.
const WEB_FN = new URL('../web-fn/', import.meta.url).pathname
const fnRequire = createRequire(`${WEB_FN}package.json`)
export function fnLib(name) {
  const app = fnRequire('firebase-admin/app')
  if (!app.getApps().length) app.initializeApp({ projectId: PROJECT, storageBucket: 'demo-zylove.appspot.com' })
  return fnRequire(`${WEB_FN}lib/${name}.js`)
}

export function sortedPair(a, b) {
  return [a, b].sort().join('_')
}

// ─── Browser ─────────────────────────────────────────────────────────────────

// Context options: Austin geolocation granted, reduced motion (short mode
// transitions), a phone-sized-but-desktop viewport.
export const CONTEXT = {
  permissions: ['geolocation'],
  geolocation: AUSTIN,
  reducedMotion: 'reduce',
  viewport: { width: 1280, height: 900 },
}

// Offline mocks: profile images and the reverse geocoder; record anything
// else leaving localhost so a test can assert nothing went out.
export async function offline(page) {
  const external = []
  await page.route('https://e2e.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await page.route('https://nominatim.openstreetmap.org/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ address: { city: 'Austin', 'ISO3166-2-lvl4': 'US-TX' } }) }),
  )
  page.on('request', (req) => {
    const h = new URL(req.url()).hostname
    if (!['localhost', '127.0.0.1', 'e2e.invalid', 'nominatim.openstreetmap.org'].includes(h) && !req.url().startsWith('data:') && !req.url().startsWith('blob:')) external.push(req.url())
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  return { external, errors }
}

// Pre-dismiss first-run modals that aren't under test.
export async function quietFirstRun(page, uid, { keyBackup = true, safetyTips = true } = {}) {
  await page.addInitScript(
    ([u, kb, st]) => {
      if (kb) localStorage.setItem(`zylove_keybackup_snooze_${u}`, String(Date.now()))
      // T&S Phase 2: the first-match safety card (SafetyTipsCard).
      if (st) localStorage.setItem(`zylove_safety_tips_${u}`, '1')
      sessionStorage.setItem('zylove_early_modal_seen', '1')
      sessionStorage.setItem('zylove_bot_banner_dismissed', '1')
      sessionStorage.setItem('zylove_location_granted', '1')
    },
    [uid, keyBackup, safetyTips],
  )
}

// Real phone sign-in through the Login page (validatePhoneNumber, reCAPTCHA
// test mode, OTP from the Auth emulator, onBeforeSignIn).
export async function signIn(page, phone, { expectPath = /\/(discover|onboarding)/ } = {}) {
  // After sign-out the app itself reloads /login (signOutAndWipe); a goto
  // racing that reload is "interrupted by another navigation" — retry.
  for (let i = 0; ; i++) {
    try {
      await page.goto(`${APP}/login`)
      break
    } catch (err) {
      if (i >= 2 || !/interrupted by another navigation/.test(String(err))) throw err
      await page.waitForLoadState('load')
    }
  }
  await page.getByLabel('Phone number (US)').fill(phone.slice(2))
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.getByText('Enter your code')).toBeVisible({ timeout: 20000 })
  let code = null
  for (let i = 0; i < 40 && !code; i++) {
    code = await smsCode(phone)
    if (!code) await page.waitForTimeout(250)
  }
  if (!code) throw new Error(`no SMS code for ${phone}`)
  await page.getByPlaceholder('123456').fill(code)
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL(expectPath, { timeout: 30000 })
}

export async function userDoc(uid) {
  return (await db.doc(`users/${uid}`).get()).data()
}

// Server-only and private docs (Stage 1a layout).
export async function internalDoc(uid) {
  return (await db.doc(`userInternal/${uid}`).get()).data()
}
export async function accountDoc(uid) {
  return (await db.doc(`users/${uid}/private/account`).get()).data()
}
export async function locationDoc(uid) {
  return (await db.doc(`userLocations/${uid}`).get()).data()
}

// Forget the user's saved location everywhere.
export async function clearLocation(uid) {
  await db.doc(`userLocations/${uid}`).delete()
  await db.doc(`users/${uid}/private/account`).set({ location: FieldValue.delete() }, { merge: true })
  await db.doc(`users/${uid}`).update({ locationLat: FieldValue.delete(), locationLng: FieldValue.delete() })
}

// ─── Acting as a user server-side (seeding real actions through callables) ──

export async function idTokenFor(uid) {
  const custom = await adminAuth.createCustomToken(uid)
  const r = await (await fetch('http://127.0.0.1:9409/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-api-key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }),
  })).json()
  if (!r.idToken) throw new Error(`custom sign-in failed for ${uid}: ${JSON.stringify(r.error)}`)
  return r.idToken
}

export async function callAs(uid, fn, data = {}) {
  const r = await fetch(`http://127.0.0.1:5311/${PROJECT}/us-central1/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await idTokenFor(uid)}` }, body: JSON.stringify({ data }),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok || body.error) throw new Error(`${fn} as ${uid} → HTTP ${r.status} ${JSON.stringify(body.error ?? body)}`)
  return body.result
}

// `from` likes `to` exactly as the app does: onTap creates the pair, onLike
// records the like. F-062: in Play the app knows `to` by their Play ID.
export async function likeAs(from, to, mode = 'spark') {
  if (mode === 'play') {
    const toPlay = await playIdOf(to)
    await callAs(from, 'onTap', { tappedPlayId: toPlay })
    return callAs(from, 'onLike', { likedUserId: toPlay, mode })
  }
  await callAs(from, 'onTap', { tappedUserId: to })
  return callAs(from, 'onLike', { likedUserId: to, mode })
}

// F-062: someone's Play ID (created if they have none yet) — read from the
// server-only mapping, as only tests may.
export async function playIdOf(uid) {
  return fnLib('playIds').ensurePlayId(uid)
}

// The Play match between two accounts (playMatches/{pm_…}), or null.
export async function playMatchOf(a, b) {
  return fnLib('playMatch').livePlayMatchOf(a, b)
}

// Stage C: a plan, set the way the server decides it (userInternal +
// refreshPlayAccess), so a test never races the background entitlement
// triggers. 'free' = a finished trial.
export async function setPlan(uid, tier) {
  const plan = tier === 'free'
    ? { subscriptionTier: 'free', trialStartedAt: Timestamp.fromMillis(Date.now() - 40 * 864e5), trialEndsAt: Timestamp.fromMillis(Date.now() - 10 * 864e5), trialExpired: true }
    : { subscriptionTier: tier }
  await db.doc(`userInternal/${uid}`).set(plan, { merge: true })
  await fnLib('playAccess').refreshPlayAccess(uid)
}
