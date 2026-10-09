// §4.A3 — anonymous likers: like ids, what a like entry and a preview may
// carry per plan, and which likes are hidden.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  LIKE_ID_RE,
  buildPreview,
  firstNameOf,
  isLikeId,
  isLive,
  likeEntryOf,
  likeVisible,
  newLikeId,
  photoDelivery,
  playSource,
  previewAllowed,
  promptsOf,
  sparkSource,
  type LikerState,
} from '../src/likerPreviewCore'
import { isPhotoRef } from '../src/storagePath'

const UID = 'e2e-gray-7'
const PLAY_ID = 'p_ABCDEFGHIJKLMNOPQRST'

test('like ids: random, opaque, never derived from the uid', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newLikeId()))
  assert.equal(ids.size, 500)
  for (const id of ids) {
    assert.match(id, LIKE_ID_RE)
    assert.ok(isLikeId(id))
  }
  // Uids, Play IDs, paths and junk are not like ids (likeBack refuses them).
  for (const bad of [UID, PLAY_ID, 'lk_short', `lk_${'a'.repeat(21)}`, 'lk_AAAAAAAAAAAAAAAAAAA/', `users/${UID}`, '', null, 42, undefined]) {
    assert.equal(isLikeId(bad), false, String(bad))
  }
})

test('like entry: when, mode, state and the headline score — no uid, Play ID, snapshot, breakdown or dealbreakers', () => {
  const raw = {
    likerUid: UID,
    likerPlayId: PLAY_ID,
    likeId: 'lk_AAAAAAAAAAAAAAAAAAAA',
    likedAt: 1700,
    mode: 'spark',
    compatibilityScore: 81,
    breakdown: { values: 90 },
    dealbreakersTriggered: ['smoking'],
    likerProfile: { displayName: 'Gray', photoURLs: [`photos/${UID}/spark/a.jpg`] },
    dismissed: false,
    isWeeklySpark: true,
  }
  const e = likeEntryOf('lk_AAAAAAAAAAAAAAAAAAAA', UID, raw)
  assert.deepEqual(e, {
    likeId: 'lk_AAAAAAAAAAAAAAAAAAAA',
    mode: 'spark',
    likedAt: 1700,
    dismissed: false,
    isWeeklySpark: true,
    expiresAt: null,
    compatibilityScore: 81,
    curated: false,
  })
  const json = JSON.stringify(e)
  for (const leak of [UID, PLAY_ID, 'Gray', 'smoking', 'breakdown', 'dealbreakers', 'values']) assert.ok(!json.includes(leak), leak)
  // Curated likes: flagged, and their placeholder score dropped.
  assert.deepEqual(
    [likeEntryOf('lk_x', 'zbot-ava', { compatibilityScore: 75 }).curated, likeEntryOf('lk_x', 'zbot-ava', { compatibilityScore: 75 }).compatibilityScore],
    [true, null],
  )
  assert.equal(likeEntryOf('lk_x', PLAY_ID, { mode: 'play', curated: true }).curated, true)
  assert.equal(likeEntryOf('lk_x', PLAY_ID, { mode: 'play' }).mode, 'play')
  // Timestamps and numbers both read as epoch ms.
  assert.equal(likeEntryOf('lk_x', UID, { likedAt: { toMillis: () => 99 } }).likedAt, 99)
})

test('live: not dismissed, not expired', () => {
  const now = 10_000
  const e = (raw: Record<string, unknown>) => isLive(likeEntryOf('lk_x', UID, raw), raw, now)
  assert.equal(e({}), true)
  assert.equal(e({ dismissed: true }), false)
  assert.equal(e({ isExpired: true }), false)
  assert.equal(e({ expiresAt: now - 1 }), false)
  assert.equal(e({ expiresAt: now + 1 }), true)
})

test('visibility: blocked either way, suspended, deleted or gone — hidden; Play also needs the liker in Play', () => {
  const ok: LikerState = { exists: true, deleted: false, suspended: false, blocked: false, playOk: true }
  assert.equal(likeVisible(ok, 'spark'), true)
  assert.equal(likeVisible(ok, 'play'), true)
  for (const k of ['deleted', 'suspended', 'blocked'] as const) {
    assert.equal(likeVisible({ ...ok, [k]: true }, 'spark'), false, k)
    assert.equal(likeVisible({ ...ok, [k]: true }, 'play'), false, k)
  }
  assert.equal(likeVisible({ ...ok, exists: false }, 'spark'), false)
  // Out of Play: the Play like is hidden, a Spark one isn't.
  assert.equal(likeVisible({ ...ok, playOk: false }, 'play'), false)
  assert.equal(likeVisible({ ...ok, playOk: false }, 'spark'), true)
})

test('plans: Free gets no preview of a real person (count only); Spark+ and Elite do; curated on every plan', () => {
  assert.equal(previewAllowed('free', false), false)
  assert.equal(previewAllowed('spark_plus', false), true)
  assert.equal(previewAllowed('elite', false), true)
  for (const p of ['free', 'spark_plus', 'elite'] as const) assert.equal(previewAllowed(p, true), true)
})

test('preview: photo, first name, bio and prompts only — from the Spark root doc', () => {
  const root = {
    uid: UID,
    displayName: 'Gray Allen Smith',
    age: 33,
    locationLabel: 'Austin, TX',
    genderIdentity: 'trans_man',
    pronouns: 'he/him',
    bio: '  Hi, I garden.  ',
    photoURLs: [`photos/${UID}/spark/a.jpg`, `photos/${UID}/spark/b.jpg`],
    promptAnswers: [
      { promptId: 'perfect_sunday', answer: 'Coffee' },
      { promptId: 'green_flag', answer: '   ' },
      { promptId: 'dynamic', answer: 'Tacos' },
    ],
    dynamicPrompt: 'Best food in town?',
    relationshipStatus: 'single',
    playDisplayName: 'Ember',
  }
  const src = sparkSource(root)
  assert.equal(src.photoRef, `photos/${UID}/spark/a.jpg`)
  const p = buildPreview('spark', false, src, 'data:image/jpeg;base64,AAAA')
  assert.deepEqual(p, {
    mode: 'spark',
    firstName: 'Gray',
    photo: 'data:image/jpeg;base64,AAAA',
    bio: 'Hi, I garden.',
    prompts: [
      { promptId: 'perfect_sunday', answer: 'Coffee' },
      { promptId: 'dynamic', answer: 'Tacos', question: 'Best food in town?' },
    ],
    curated: false,
  })
  const json = JSON.stringify(p)
  for (const leak of [UID, 'Allen', 'Smith', '33', 'Austin', 'trans', 'he/him', 'single', 'Ember', 'photos/']) assert.ok(!json.includes(leak), leak)
})

test('preview: a Play like comes from the public Play copy — Play name, Play photo, Play bio and prompts', () => {
  const play = {
    playDisplayName: 'Ember',
    playBio: 'Play bio',
    photoURLs: [`playPhotos/${PLAY_ID}/x.jpg`],
    playPromptAnswers: { wild_card: 'Dancing', empty: '' },
    spiceLevel: 'spicy',
    age: 30,
    curated: false,
  }
  const p = buildPreview('play', false, playSource(play), null)
  assert.deepEqual(p, { mode: 'play', firstName: 'Ember', photo: null, bio: 'Play bio', prompts: [{ promptId: 'wild_card', answer: 'Dancing' }], curated: false })
  assert.equal(playSource(play).photoRef, `playPhotos/${PLAY_ID}/x.jpg`)
  // The array form wins when both exist.
  assert.deepEqual(promptsOf([{ promptId: 'a', answer: 'x' }], { b: 'y' }), [{ promptId: 'a', answer: 'x' }])
})

test('preview photo: a Storage path or URL goes inline; any other https URL as is unless it names the liker', () => {
  const isStorage = (r: string) => r.includes('storage.googleapis.com') || isPhotoRef(r)
  assert.equal(photoDelivery(`photos/${UID}/spark/a.jpg`, [UID], isStorage), 'inline')
  assert.equal(photoDelivery(`playPhotos/${PLAY_ID}/a.jpg`, [UID, PLAY_ID], isStorage), 'inline')
  assert.equal(photoDelivery(`https://storage.googleapis.com/b/photos/${UID}/spark/a.jpg?sig`, [UID], isStorage), 'inline')
  assert.equal(photoDelivery('https://cdn.example/bot.png', [UID, PLAY_ID], isStorage), 'url')
  assert.equal(photoDelivery(`https://cdn.example/${UID}.png`, [UID], isStorage), null)
  assert.equal(photoDelivery(`https://cdn.example/${PLAY_ID}.png`, [UID, PLAY_ID], isStorage), null)
  assert.equal(photoDelivery('http://plain.example/a.png', [UID], isStorage), null)
  assert.equal(photoDelivery(null, [UID], isStorage), null)
})

test('first name: the first word, trimmed; Someone when empty', () => {
  assert.equal(firstNameOf('  Mary Jane '), 'Mary')
  assert.equal(firstNameOf(''), 'Someone')
  assert.equal(firstNameOf(undefined), 'Someone')
  assert.equal(firstNameOf('x'.repeat(100)).length, 40)
})
