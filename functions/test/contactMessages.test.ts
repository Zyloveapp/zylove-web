// The /contact form: the limits and the field checks
// (functions/src/contactMessages.ts). Its caller address and hashed key are
// clientIp.ts's (clientIp.test.ts).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { CONTACT_DAILY, CONTACT_PER_IP, parseContactMessage } from '../src/contactMessages'

test('limits: 5 an hour per address, 200 a day in all', () => {
  assert.deepEqual(CONTACT_PER_IP, { max: 5, windowMs: 60 * 60 * 1000 })
  assert.deepEqual(CONTACT_DAILY, { max: 200, windowMs: 24 * 60 * 60 * 1000 })
})

test('fields: trimmed, sized like the old rule, a real email, nothing extra', () => {
  const ok = { name: ' Ann ', email: ' Ann@Example.com ', topic: 'Press or media', message: ' Hello ' }
  assert.deepEqual(parseContactMessage(ok), { name: 'Ann', email: 'ann@example.com', topic: 'Press or media', message: 'Hello' })
  assert.equal(parseContactMessage({ ...ok, topic: undefined }).topic, '')
  assert.throws(() => parseContactMessage({ ...ok, name: '' }))
  assert.throws(() => parseContactMessage({ ...ok, name: 'x'.repeat(101) }))
  assert.throws(() => parseContactMessage({ ...ok, email: 'not-an-email' }))
  assert.throws(() => parseContactMessage({ ...ok, email: `${'a'.repeat(250)}@b.co` }))
  assert.throws(() => parseContactMessage({ ...ok, topic: 'x'.repeat(101) }))
  assert.throws(() => parseContactMessage({ ...ok, message: '   ' }))
  assert.throws(() => parseContactMessage({ ...ok, message: 'x'.repeat(1001) }))
  assert.doesNotThrow(() => parseContactMessage({ ...ok, message: 'x'.repeat(1000) }))
  assert.throws(() => parseContactMessage({ ...ok, createdAt: 1 }), /Unknown field/)
  assert.throws(() => parseContactMessage({ ...ok, handled: true }), /Unknown field/)
  assert.throws(() => parseContactMessage(null))
  assert.throws(() => parseContactMessage({ ...ok, name: 42 }))
})
