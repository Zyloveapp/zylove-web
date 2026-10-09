// F-079 — names in texts: plain names pass (trimmed to 20 characters);
// anything link-, handle- or number-like becomes 'Someone'.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { smsSafeName } from '../src/smsName'

test('ordinary names pass, whitespace collapsed', () => {
  for (const n of ['Sam', "O'Brien", 'Mary-Jane', 'D’Angelo', 'José', '李小龍', 'Jo 2']) assert.equal(smsSafeName(n), n)
  assert.equal(smsSafeName('  Ann   Marie \n'), 'Ann Marie')
  assert.equal(smsSafeName('Ann​Marie'), 'AnnMarie')
})

test('at most 20 characters', () => {
  assert.equal(smsSafeName('Bartholomew Montgomery-Smythe'), 'Bartholomew Montgome')
  assert.equal(Array.from(smsSafeName('😀'.repeat(30))).length, 20)
})

test('links, handles and numbers become Someone', () => {
  for (const n of [
    'bit.ly/x', 'zylove.app', 'evil.com', 'http://x', 'x:y', '@janedoe', 'me@mail', 'www', 'WWW site', 'a\\b',
    '5125550134', 'Call 555', '555 01 34 2', 'Jo 12 34 5',
  ]) assert.equal(smsSafeName(n), 'Someone', n)
})

test('empty or not a string: Someone', () => {
  for (const n of ['', '   ', null, undefined, 42, {}]) assert.equal(smsSafeName(n), 'Someone')
})
