// The /contact form: the caller address behind the rate limit, its hashed
// key, and the field checks (functions/src/contactMessages.ts).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { CONTACT_DAILY, CONTACT_PER_IP, callerIp, ipRateKey, parseContactMessage } from '../src/contactMessages'

const req = (xff?: string | string[], ip?: string) => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, ip })

test('limits: 5 an hour per address, 200 a day in all', () => {
  assert.deepEqual(CONTACT_PER_IP, { max: 5, windowMs: 60 * 60 * 1000 })
  assert.deepEqual(CONTACT_DAILY, { max: 200, windowMs: 24 * 60 * 60 * 1000 })
})

test('caller address: the last X-Forwarded-For hop, never a client-sent earlier one', () => {
  assert.equal(callerIp(req('203.0.113.9')), '203.0.113.9')
  // A client sending its own header can only add hops in front.
  assert.equal(callerIp(req('1.1.1.1, 2.2.2.2, 198.51.100.7', '1.1.1.1')), '198.51.100.7')
  assert.equal(callerIp(req(['1.1.1.1', ' 198.51.100.7 '])), '198.51.100.7')
  assert.equal(callerIp(req('1.1.1.1, ')), '1.1.1.1')
  // No header (emulator, direct): the connection.
  assert.equal(callerIp(req(undefined, '127.0.0.1')), '127.0.0.1')
  assert.equal(callerIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1')
  assert.equal(callerIp(undefined), null)
  assert.equal(callerIp(req('x'.repeat(200)))?.length, 64)
})

test('rate-limit key: a hash of the address, never the address itself', () => {
  const k = ipRateKey('198.51.100.7')
  assert.match(k, /^ip_[0-9a-f]{32}$/)
  assert.equal(k.includes('198.51'), false)
  assert.equal(ipRateKey('198.51.100.7'), k)
  assert.notEqual(ipRateKey('198.51.100.8'), k)
  // A spoofed first hop lands in the same bucket.
  assert.equal(ipRateKey(callerIp(req('9.9.9.9, 198.51.100.7'))), ipRateKey(callerIp(req('8.8.8.8, 198.51.100.7'))))
  assert.equal(ipRateKey(null), ipRateKey('unknown'))
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
