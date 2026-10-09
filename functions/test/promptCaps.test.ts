// H7 (fresh-eyes review 2026-10-09): prompts built from stored profile
// fields are capped server-side — a padded doc (a 1 MB bio, thousands of
// tags or answers) used to go into the prompt whole.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { MAX_PROMPT_CHARS } from '../src/aiCall'
import { PROMPT_CAPS, capBlock, capList, capText } from '../src/promptCaps'
import { buildPlayStarterPrompt, buildProfileQuestionPrompt, buildStarterPrompt, ownPromptAnswers, playPersonLine, profileForReview } from '../src/profilePrompts'
import { buildPlayReviewPrompt } from '../src/playReviewPrompt'
import { buildPlayBioPrompt, parsePlayBioRequest } from '../src/playBioPrompt'
import { buildPlayGoDeeperPrompt, parsePlayGoDeeperRequest } from '../src/playGoDeeperPrompt'
import { buildSparkGoDeeperPrompt, parseSparkGoDeeperRequest } from '../src/sparkGoDeeperPrompt'

const MB = 'x'.repeat(1_000_000)
const many = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i))

// A Spark profile padded every way the rules allow(ed).
const padded = {
  displayName: MB,
  bio: MB,
  genderLine: MB,
  dynamicPrompt: MB,
  conflictStyle: MB,
  togethernessStyle: MB,
  stressResponse: MB,
  lifestyleTags: many(5000, (i) => `tag_${i}_${'y'.repeat(200)}`),
  relationshipValues: many(5000, () => MB.slice(0, 1000)),
  personalityTraits: many(5000, (i) => `t${i}`),
  habitTags: many(5000, (i) => `h${i}`),
  weekendVibes: many(5000, (i) => `w${i}`),
  openTo: many(5000, (i) => `o${i}`),
  loveLangGive: many(5000, (i) => `g${i}`),
  loveLangReceive: many(5000, (i) => `r${i}`),
  promptAnswers: many(2000, (i) => ({ promptId: `p${i}${'z'.repeat(500)}`, answer: MB.slice(0, 5000) })),
}
const paddedSpark = { bio: MB, sparkPromptAnswers: Object.fromEntries(many(2000, (i): [string, string] => [`p${i}`, MB.slice(0, 5000)])) }

test('the primitives', () => {
  assert.equal(capText('  hi  '), 'hi')
  assert.equal(capText(MB).length, PROMPT_CAPS.text)
  assert.equal(capText(42), '')
  assert.deepEqual(capList(['a', 'a', ' b ', '', 7, 'c'], 2), ['a', 'b'])
  assert.equal(capList(many(1000, (i) => `${i}${MB.slice(0, 100)}`)).length, PROMPT_CAPS.items)
  assert.ok(capList([MB])[0].length <= PROMPT_CAPS.item)
  assert.deepEqual(capList('not a list'), [])
  assert.equal(capBlock('short'), 'short')
  assert.equal(capBlock(MB).length, PROMPT_CAPS.block)
})

test('the Spark review and "Just for you" prompts from a padded profile stay small', () => {
  const review = profileForReview(padded, paddedSpark)
  assert.ok(review.length <= PROMPT_CAPS.block, String(review.length))
  const question = buildProfileQuestionPrompt(padded, paddedSpark)
  assert.ok(question.length < 8000, String(question.length))
  const answers = ownPromptAnswers(padded, paddedSpark)
  assert.equal(answers.length, PROMPT_CAPS.answers)
  assert.ok(answers.every((a) => a.answer.length <= PROMPT_CAPS.answer && a.question.length <= PROMPT_CAPS.answer))
  // From the root doc's list too (no Spark doc).
  const fromRoot = ownPromptAnswers(padded, {})
  assert.equal(fromRoot.length, PROMPT_CAPS.answers)
  assert.ok(fromRoot.every((a) => a.question.length <= PROMPT_CAPS.short && a.answer.length <= PROMPT_CAPS.answer))
})

test('a real profile is untouched by the caps', () => {
  const real = {
    displayName: 'Ann', age: 30, bio: 'I like long walks.'.padEnd(300, '.'),
    lifestyleTags: ['outdoorsy', 'foodie'], personalityTraits: ['curious'], relationshipValues: ['honesty'],
    promptAnswers: [{ promptId: 'green_flag', answer: 'Kindness'.padEnd(200, '!') }], conflictStyle: 'talk_it_out',
  }
  const review = profileForReview(real, {})
  assert.ok(review.includes(real.bio))
  assert.ok(review.includes(real.promptAnswers[0].answer))
  assert.ok(review.includes('outdoorsy, foodie'))
  assert.ok(review.includes('Conflict style: talk it out'))
})

test('conversation starters: both people capped — the other person\'s padded doc too', () => {
  const spark = buildStarterPrompt({ displayName: 'Ann', lifestyleTags: ['foodie'] }, padded)
  assert.ok(spark.length < 2 * PROMPT_CAPS.block + 2000, String(spark.length))
  const playDoc = { playDisplayName: MB, playBio: MB, spiceLevel: MB, playInterestTags: many(100000, () => 'fwb'), promptAnswers: padded.promptAnswers }
  const play = buildPlayStarterPrompt([playPersonLine({}, playDoc), playPersonLine(padded, playDoc)])
  assert.ok(play.length < 2 * PROMPT_CAPS.block + 2000, String(play.length))
})

test('Play review, bio and Go Deeper: a tag repeated any number of times is one tag', () => {
  const tags = many(100000, () => 'fwb')
  const review = buildPlayReviewPrompt({
    playBio: MB, playInterestTags: tags, playNonNegotiables: many(10000, () => 'safe_sex_only'),
    playPromptAnswers: padded.promptAnswers, goDeeper: many(1000, () => ({ question: MB, answer: MB })),
  })
  assert.ok(review.length < MAX_PROMPT_CHARS, String(review.length))
  assert.ok(review.length < 12000, String(review.length))
  assert.deepEqual(parsePlayBioRequest({ arrangement: tags }).arrangement, ['fwb'])
  assert.ok(buildPlayBioPrompt(parsePlayBioRequest({ arrangement: tags, acts: tags, genderIdentity: many(10000, () => 'man') })).length < 6000)
  assert.deepEqual(parsePlayGoDeeperRequest({ arrangementTags: tags }).arrangement, ['fwb'])
  assert.ok(buildPlayGoDeeperPrompt(parsePlayGoDeeperRequest({ arrangementTags: tags }), { focus: 'f' }).length < 6000)
  const spark = parseSparkGoDeeperRequest({ lifestyle: many(100000, () => 'foodie'), personality: many(100000, () => 'curious') })
  assert.ok(buildSparkGoDeeperPrompt(spark, { focus: 'f' }).length < 6000)
})
