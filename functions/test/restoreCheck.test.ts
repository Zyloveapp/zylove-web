// F-086: restoring a deleted account needs the old birthday, typed.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Timestamp } from 'firebase-admin/firestore'
import { isoDate, restoreBirthdayMatches, storedBirthday } from '../src/restoreCheck'

test('restore: a typed birthday must be a real YYYY-MM-DD date', () => {
  assert.equal(isoDate('1995-03-14'), '1995-03-14')
  assert.equal(isoDate(' 1995-03-14 '), '1995-03-14')
  for (const bad of ['1995-02-30', '1995-13-01', '03/14/1995', '1995-3-14', '', null, undefined, 19950314, {}]) assert.equal(isoDate(bad), null, String(bad))
})

test('restore: the stored birthday — ISO string, ISO timestamp or Timestamp', () => {
  assert.equal(storedBirthday('1995-03-14'), '1995-03-14')
  assert.equal(storedBirthday('1995-03-14T00:00:00.000Z'), '1995-03-14')
  assert.equal(storedBirthday(Timestamp.fromMillis(Date.UTC(1995, 2, 14))), '1995-03-14')
  assert.equal(storedBirthday(null), null)
  assert.equal(storedBirthday(undefined), null)
  assert.equal(storedBirthday(''), null)
})

test('restore: matches only the same date; no record birthday never matches', () => {
  assert.equal(restoreBirthdayMatches('1995-03-14', '1995-03-14'), true)
  assert.equal(restoreBirthdayMatches('1995-03-15', '1995-03-14'), false)
  assert.equal(restoreBirthdayMatches('1995-14-03', '1995-03-14'), false)
  assert.equal(restoreBirthdayMatches(undefined, '1995-03-14'), false)
  assert.equal(restoreBirthdayMatches('1995-03-14', null), false)
  assert.equal(restoreBirthdayMatches(null, null), false)
  assert.equal(restoreBirthdayMatches('', ''), false)
})
