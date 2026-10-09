// F-099 — the 30-day limit on changing religion, politics, drinking,
// attraction, dealbreakers and intent: what counts as a change, when a field
// unlocks, and the copy. The rules enforce it (e2e spec 38).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  FIELD_CHANGE_MS, isUnset, lockedMessage, lockedUntil, needsStamp, normaliseValue, sameValue, unlockMessage,
} from '../src/shared/fieldLimits'

const DAY = 24 * 60 * 60 * 1000
// Noon UTC, so the date is the same in any US time zone.
const OCT_9 = Date.UTC(2026, 9, 9, 12)

test('unset: absent, null, empty string and empty list; anything else is a value', () => {
  for (const v of [undefined, null, '', []]) assert.equal(isUnset(v), true, JSON.stringify(v))
  for (const v of ['christian', ['women'], 0, false]) assert.equal(isUnset(v), false, JSON.stringify(v))
})

test('same value: a reordered or repeated list is the same; unset forms are all the same', () => {
  assert.equal(sameValue(['women', 'men'], ['men', 'women']), true)
  assert.equal(sameValue(['men', 'men'], ['men']), true)
  assert.equal(sameValue(['men'], ['men', 'women']), false)
  assert.equal(sameValue(null, undefined), true)
  assert.equal(sameValue([], null), true)
  assert.equal(sameValue('', null), true)
  assert.equal(sameValue('christian', 'christian'), true)
  assert.equal(sameValue('christian', 'jewish'), false)
  assert.equal(sameValue('christian', null), false)
  assert.deepEqual(normaliseValue(['women', 'men', 'women']), ['men', 'women'])
  assert.equal(normaliseValue([]), null)
})

test('the first value is free (no stamp); every later change, clearing included, stamps', () => {
  assert.equal(needsStamp(null, null), false)
  assert.equal(needsStamp([], null), false)
  assert.equal(needsStamp(undefined, null), false)
  assert.equal(needsStamp('christian', null), true) // a value set before (onboarding, or before the limit)
  assert.equal(needsStamp(null, OCT_9), true) // cleared within the limit: setting it again is a change
  assert.equal(needsStamp(['men'], OCT_9 - 40 * DAY), true)
})

test('locked for 30 days after a change, then free', () => {
  assert.equal(lockedUntil(null, OCT_9), null)
  assert.equal(lockedUntil(OCT_9, OCT_9), OCT_9 + FIELD_CHANGE_MS)
  assert.equal(lockedUntil(OCT_9 - 29 * DAY, OCT_9), OCT_9 + DAY)
  assert.equal(lockedUntil(OCT_9 - 30 * DAY, OCT_9), null)
  assert.equal(lockedUntil(OCT_9 - 31 * DAY, OCT_9), null)
  assert.equal(lockedUntil(OCT_9 - 30 * DAY + 1, OCT_9), OCT_9 + 1)
})

test('the copy names the date it unlocks, in the viewer\'s time zone', () => {
  const at = OCT_9 + FIELD_CHANGE_MS
  assert.equal(unlockMessage(at, 'America/Chicago'), 'You can change this again on November 8.')
  assert.equal(lockedMessage([{ field: 'religion', until: at }], 'America/Chicago'), 'You can change your religion again on November 8.')
  assert.equal(
    lockedMessage([{ field: 'attractedTo', until: at }, { field: 'intent', until: at + DAY }], 'America/Chicago'),
    "You can change who you're attracted to again on November 8. You can change what you're here for again on November 9.",
  )
  // Late evening in Chicago is the next day in UTC.
  const late = Date.UTC(2026, 10, 9, 3)
  assert.equal(unlockMessage(late, 'America/Chicago'), 'You can change this again on November 8.')
  assert.equal(unlockMessage(late, 'UTC'), 'You can change this again on November 9.')
})

test('the app\'s copy of the helper matches this one', () => {
  const body = (p: string) => readFileSync(new URL(p, `file://${__dirname}/`), 'utf8').split('\n').slice(1).join('\n')
  assert.equal(body('../../../src/services/fieldLimits.ts'), body('../../src/shared/fieldLimits.ts'))
})
