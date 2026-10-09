// Fresh-eyes review 2026-10-09, cost and abuse:
// C2 — an AI use was given back whenever the reply was filtered or didn't
//      parse, so a caller who steers the output looped paid calls without
//      limit. Now only a failed call (network, non-2xx) is given back, and
//      every AI callable has a per-uid rate limit (10 an hour) on top.
// H7 — prompts built from stored profile fields had no size limit. Now the
//      rules bound the fields' sizes and the server caps every piece.
// H8 — every profile write re-scored all of the user's pairs. Now at most
//      once per 10 minutes per user; sweepRescores re-scores what was held
//      back; profileUpdatedAt is server-only.
// And: a Play re-score replaces the stored tier1Play / playBreakdown whole
//      (the merge kept the keys F-098 trimmed).
// The model is the e2e stub (stub-anthropic.cjs), which logs every prompt.
import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { resetEmulators, seedUser, callAs, likeAs, setPlan, playIdOf, sortedPair, idTokenFor, fnLib, db, PROJECT, FieldValue } from './helpers.mjs'

test.beforeEach(resetEmulators)

const LOG = new URL('../.cache/anthropic-requests.jsonl', import.meta.url)
test.beforeAll(() => writeFileSync(LOG, ''))
// The prompts the stub saw whose start contains `marker`.
const prompts = (marker) =>
  readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.head.includes(marker))

const woman = (name, o = {}, opts = {}) => seedUser(name, { genderIdentity: 'woman', attractedTo: ['men'], ...o }, opts)
const PLAY = (name) => ({ playDisplayName: name, playBio: `${name}'s Play bio`, spiceLevel: 'spicy', playInterestTags: ['fwb', 'playful', 'kissing'] })
const usage = async (uid) => (await db.doc(`usage/${uid}`).get()).data() ?? {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─── Client writes through the REST API with the owner's ID token ────────────
const DOCS = `projects/${PROJECT}/databases/(default)/documents`
function val(v) {
  if (v === null) return { nullValue: null }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(val) } }
  if (typeof v === 'number') return { integerValue: String(v) }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)])) } }
  return { stringValue: v }
}
// Sets `set`'s fields; `now`: fields set to the request time (serverTimestamp()).
async function clientWrite(uid, path, set = {}, now = []) {
  const r = await fetch(`http://127.0.0.1:8390/v1/${DOCS}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await idTokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [{
        update: { name: `${DOCS}/${path}`, fields: Object.fromEntries(Object.entries(set).map(([k, v]) => [k, val(v)])) },
        updateMask: { fieldPaths: Object.keys(set) },
        updateTransforms: now.map((f) => ({ fieldPath: f, setToServerValue: 'REQUEST_TIME' })),
      }],
    }),
  })
  return r.status
}

// ─── C2 ──────────────────────────────────────────────────────────────────────

test('C2: a review whose reply doesn\'t parse still counts — the second try is refused, not another paid call', async () => {
  const a = await seedUser('Rev')
  await setPlan(a.uid, 'free') // Free: one Spark review, ever
  await expect(callAs(a.uid, 'reviewProfile')).rejects.toThrow(/unavailable|UNAVAILABLE/) // the stub's reply isn't a scorecard
  // Before: given back, so this was another billed call (and so on, forever).
  await expect(callAs(a.uid, 'reviewProfile')).rejects.toThrow(/resource-exhausted|RESOURCE_EXHAUSTED/)
  expect((await usage(a.uid)).sparkReview.life).toBe(1)
  expect(prompts('Name: Rev').length).toBe(1)
})

test('C2: a bio the output filter drops (a link, a number) still counts', async () => {
  const a = await seedUser('Bio')
  await setPlan(a.uid, 'free')
  const input = { displayName: 'Bio', sparkPromptAnswers: { green_flag: `E2E-ANTHROPIC-LINK ${a.uid}` } }
  expect(await callAs(a.uid, 'generateSparkBio', input)).toEqual({ bio: '' }) // dropped by safeBio
  expect(await callAs(a.uid, 'generateSparkBio', input)).toEqual({ bio: '', limited: true })
  expect((await usage(a.uid)).sparkBio.life).toBe(1)
  expect(prompts(a.uid).length).toBe(1)
})

test('C2: a failed call is given back — and the rate limit (10 an hour per callable) caps the retries', async () => {
  const a = await seedUser('Ret')
  await setPlan(a.uid, 'elite') // 5 Spark bios a month
  const input = { displayName: 'Ret', sparkPromptAnswers: { green_flag: `E2E-ANTHROPIC-500 ${a.uid}` } }
  for (let i = 0; i < 12; i++) expect(await callAs(a.uid, 'generateSparkBio', input)).toEqual({ bio: '' })
  // Every failed call was given back…
  const month = fnLib('usage').periodKey('month')
  expect((await usage(a.uid)).sparkBio?.[month] ?? 0).toBe(0)
  // …and only 10 reached the model: the 11th and 12th met the rate limit.
  expect(prompts(a.uid).length).toBe(10)
  expect((await db.doc(`rateLimits/${a.uid}`).get()).data().ai_sparkBio.length).toBe(10)
  // A callable that passes errors on says so.
  await db.doc(`rateLimits/${a.uid}`).set({ ai_sparkReview: Array.from({ length: 10 }, () => Date.now()) }, { merge: true })
  await expect(callAs(a.uid, 'reviewProfile')).rejects.toThrow(/Too many requests/)
  expect((await usage(a.uid)).sparkReview).toBeUndefined()
})

// ─── H7 ──────────────────────────────────────────────────────────────────────

test('H7: the rules refuse an oversized bio or list (root, Spark and Play docs); a doc already over a limit still takes other edits', async () => {
  const a = await seedUser('Siz', {}, { play: PLAY('Sizzle') })
  const big = 'x'.repeat(600)
  expect(await clientWrite(a.uid, `users/${a.uid}`, { bio: big })).toBe(403)
  expect(await clientWrite(a.uid, `users/${a.uid}`, { lifestyleTags: Array.from({ length: 41 }, (_, i) => `t${i}`) })).toBe(403)
  expect(await clientWrite(a.uid, `users/${a.uid}`, { promptAnswers: Array.from({ length: 21 }, () => ({ promptId: 'green_flag', answer: 'a' })) })).toBe(403)
  expect(await clientWrite(a.uid, `users/${a.uid}/sparkProfile/data`, { bio: big })).toBe(403)
  expect(await clientWrite(a.uid, `users/${a.uid}/playProfile/data`, { playBio: big })).toBe(403)
  expect(await clientWrite(a.uid, `users/${a.uid}/playProfile/data`, { playInterestTags: Array.from({ length: 151 }, () => 'fwb') })).toBe(403)
  // What the app writes is fine.
  expect(await clientWrite(a.uid, `users/${a.uid}`, { bio: 'b'.repeat(300), lifestyleTags: ['foodie', 'outdoorsy'] })).toBe(200)
  expect(await clientWrite(a.uid, `users/${a.uid}/playProfile/data`, { playBio: 'p'.repeat(300) })).toBe(200)
  // Saved over the limit before the rule: other fields still save; the bio
  // only shrinks into it.
  await db.doc(`users/${a.uid}`).update({ bio: 'o'.repeat(5000) })
  expect(await clientWrite(a.uid, `users/${a.uid}`, { lifestyleTags: ['foodie'] })).toBe(200)
  expect(await clientWrite(a.uid, `users/${a.uid}`, { bio: 'o'.repeat(4000) })).toBe(403)
  expect(await clientWrite(a.uid, `users/${a.uid}`, { bio: 'short now' })).toBe(200)
})

// A profile padded the way the rules used to allow (admin-written here).
// (Under Firestore's 1 MiB a doc.)
const BIG = 'y'.repeat(100_000)
const PADDED = {
  bio: BIG,
  lifestyleTags: Array.from({ length: 2000 }, (_, i) => `tag_${i}_${'z'.repeat(60)}`),
  relationshipValues: Array.from({ length: 2000 }, (_, i) => `v_${i}`),
  promptAnswers: Array.from({ length: 400 }, () => ({ promptId: 'green_flag', answer: 'w'.repeat(1000) })),
}

test('H7: a padded stored profile yields a capped prompt — the review, and the other person\'s doc in openers', async () => {
  const a = await seedUser('Padrev', PADDED)
  await db.doc(`users/${a.uid}/sparkProfile/data`).update({ bio: BIG, promptAnswers: PADDED.promptAnswers })
  await setPlan(a.uid, 'elite')
  await expect(callAs(a.uid, 'reviewProfile')).rejects.toThrow(/unavailable|UNAVAILABLE/)
  const [review] = prompts('Name: Padrev')
  // Before: the whole bio and every tag and answer (over 600,000 characters).
  expect(review.length).toBeLessThan(20000)

  const me = await seedUser('Opa')
  const them = await woman('Padopen', PADDED)
  await likeAs(me.uid, them.uid)
  const { matchId } = await likeAs(them.uid, me.uid)
  await callAs(me.uid, 'generateConversationStarter', { matchId, otherUid: them.uid })
  const [starter] = prompts('Padopen')
  expect(starter.length).toBeLessThan(20000)
  expect(starter.head).toContain('Opa')

  await callAs(a.uid, 'generateProfileQuestion')
  const question = prompts('Name: Padrev').find((r) => r.head.startsWith('Based on this person'))
  expect(question.length).toBeLessThan(10000)
})

// ─── H8 ──────────────────────────────────────────────────────────────────────

test('H8: profileUpdatedAt is the server\'s — a client write of it is refused; ordinary edits still save', async () => {
  const a = await seedUser('Stamp')
  expect(await clientWrite(a.uid, `users/${a.uid}`, {}, ['profileUpdatedAt'])).toBe(403)
  expect(await clientWrite(a.uid, `users/${a.uid}`, { bio: 'edited' }, ['profileUpdatedAt'])).toBe(403)
  expect(await clientWrite(a.uid, `users/${a.uid}`, { bio: 'edited' })).toBe(200)
})

test('H8: a burst of profile writes re-scores once; the sweep re-scores the final state; a new pair still scores at once', async () => {
  const a = await seedUser('Bur')
  const b = await woman('Bea')
  const c = await woman('Cat')
  // The production window for these two (the emulator otherwise re-scores
  // at once), starting now — so the seeding's late triggers don't re-score.
  const windowed = (u, extra = {}) => db.doc(`rateLimits/${u.uid}`).set({ rescoreWindowMs: 10 * 60 * 1000, rescoreLastRunAt: Date.now(), ...extra }, { merge: true })
  await windowed(a)
  await windowed(b)
  await likeAs(a.uid, b.uid) // onTap creates the scored pair
  const ref = db.doc(`pairs/${sortedPair(a.uid, b.uid)}`)
  const version = async () => (await ref.get()).data().scoreVersion
  // Let the like's triggers settle (spec 07's wait).
  for (let last = -1, cur = await version(); cur !== last; ) { last = cur; await sleep(2000); cur = await version() }
  const v0 = await version()
  // a's window starts clean: the burst's first write re-scores at once.
  await windowed(a, { rescoreLastRunAt: FieldValue.delete(), rescoreDueAt: FieldValue.delete() })
  await windowed(b, { rescoreDueAt: FieldValue.delete() })

  // Six edits of the age range (not under F-099's 30-day limit), as the app writes them.
  for (const ageMin of [22, 23, 24, 25, 26, 31]) expect(await clientWrite(a.uid, `users/${a.uid}/private/matching`, { ageMin })).toBe(200)
  await expect.poll(version, { timeout: 20000 }).toBeGreaterThan(v0)
  await sleep(6000)
  // Before: one re-score per write (v0 + 6).
  expect(await version()).toBe(v0 + 1)
  const owed = (await db.doc(`rateLimits/${a.uid}`).get()).data()
  expect(owed.rescoreDueAt).toBeGreaterThan(Date.now() + 5 * 60 * 1000)

  // A new pair inside the window scores at once (onTap).
  const tap = await callAs(a.uid, 'onTap', { tappedUserId: c.uid })
  expect(typeof tap.sparkScore).toBe('number')

  // Ten minutes on: the sweep re-scores from the docs as they are now.
  await db.doc(`rateLimits/${a.uid}`).update({ rescoreDueAt: Date.now() - 1000 })
  const { sweepRescores, scoringDocs } = fnLib('legacy/onProfileWrite')
  await sweepRescores.run({})
  expect(await version()).toBe(v0 + 2)
  expect((await db.doc(`rateLimits/${a.uid}`).get()).data().rescoreDueAt).toBeUndefined()
  const { calculateSparkScore } = fnLib('legacy/scoring')
  const docsOf = async (u) => scoringDocs(u.uid, (await db.doc(`users/${u.uid}`).get()).data())
  const expected = calculateSparkScore((await docsOf(a)).spark, (await docsOf(b)).spark)
  expect((await db.doc(`users/${a.uid}/private/matching`).get()).data().ageMin).toBe(31)
  expect((await ref.get()).data().sparkScore).toBe(expected.score)
  // Nothing owed: the sweep leaves it alone.
  await sweepRescores.run({})
  expect(await version()).toBe(v0 + 2)
})

// ─── Play scores: replaced whole ─────────────────────────────────────────────

test('Play re-score: an old-shape tier1Play / playBreakdown is replaced whole (no pre-trim keys); likes kept', async () => {
  const a = await seedUser('Ply', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Ember') })
  const b = await woman('Plb', { intent: 'open', onboardingPath: 'both' }, { play: PLAY('Velvet') })
  await setPlan(a.uid, 'elite')
  await callAs(a.uid, 'onTap', { tappedPlayId: await playIdOf(b.uid) })
  const key = [await playIdOf(a.uid), await playIdOf(b.uid)].sort().join('_')
  const pairRef = db.doc(`playPairData/${key}`)
  const { hasRawPlayTier1 } = fnLib('legacy/scoring')
  const plant = () => pairRef.update({
    tier1Play: { archetype: { id: 'slow_burn', label: 'Slow Burn', copy: 'p', confidence: 0.91 }, combinedScore: 64.37, asymmetryGap: 2, dataConfidence: 0.8 },
    'playBreakdown.legacyCategory': 5,
    likedBy: FieldValue.arrayUnion(a.uid),
  })
  const check = async () => {
    const d = (await pairRef.get()).data()
    if (d.tier1Play) expect(hasRawPlayTier1(d.tier1Play)).toBe(false)
    expect(JSON.stringify(d.tier1Play ?? null)).not.toMatch(/confidence|asymmetryGap|dataConfidence/)
    expect(d.playBreakdown.legacyCategory).toBeUndefined()
    expect(Object.keys(d.playBreakdown).sort()).toEqual(['energyVibe', 'intentionsLimits', 'nonNegotiables', 'physicalCompatibility'])
    expect(d.likedBy).toContain(a.uid)
  }

  // A live re-score (a Play profile edit)…
  await plant()
  await db.doc(`users/${a.uid}/playProfile/data`).update({ playBio: 'changed', lastUpdated: Date.now() })
  await expect.poll(async () => (await pairRef.get()).data().playBreakdown.legacyCategory ?? null, { timeout: 20000 }).toBeNull()
  await check()

  // …and scripts/rescore-pairs.mjs --apply's write (same setPlayScores).
  await plant()
  const { scoringDocs } = fnLib('legacy/onProfileWrite')
  const { calculatePlayScore, SCORE_ENGINE_VERSION } = fnLib('legacy/scoring')
  const { playFields, setPlayScores } = fnLib('pairPlay')
  const docsOf = async (uid) => scoringDocs(uid, (await db.doc(`users/${uid}`).get()).data())
  const r = calculatePlayScore((await docsOf(a.uid)).full, (await docsOf(b.uid)).full)
  await setPlayScores(a.uid, b.uid, { ...playFields(r.score, r.breakdown, r.tier1), engineVersion: SCORE_ENGINE_VERSION })
  await check()
  // The script's dry-run count of pre-trim Play docs is now 0.
  const all = (await db.collection('playPairData').get()).docs.map((d) => d.data())
  expect(all.filter((d) => d.tier1Play && hasRawPlayTier1(d.tier1Play)).length).toBe(0)
})
