// The caller's address (F-073) and its hashed rate-limit key
// (functions/src/clientIp.ts) — behind IP bans, the signup country, the
// Terms-acceptance record and the per-address limits.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { clientIp, ipRateKey } from '../src/clientIp'

const req = (xff?: string | string[], ip?: string) => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, ip })

test('address: the last X-Forwarded-For hop, never a client-sent earlier one', () => {
  // A single entry: Google's own.
  assert.equal(clientIp(req('203.0.113.9')), '203.0.113.9')
  // A client sending its own header can only add hops in front.
  assert.equal(clientIp(req('6.6.6.6, 198.51.100.7')), '198.51.100.7')
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2, 198.51.100.7', '1.1.1.1')), '198.51.100.7')
  assert.equal(clientIp(req(['1.1.1.1', ' 198.51.100.7 '])), '198.51.100.7')
  assert.equal(clientIp(req('1.1.1.1, ')), '1.1.1.1')
  assert.equal(clientIp(req('2001:db8::1, 2001:db8::7')), '2001:db8::7')
})

test('address: no header (emulator, direct) — the connection', () => {
  assert.equal(clientIp(req(undefined, '127.0.0.1')), '127.0.0.1')
  assert.equal(clientIp(req('', '127.0.0.1')), '127.0.0.1')
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1')
  assert.equal(clientIp({ headers: {} }), null)
  assert.equal(clientIp(undefined), null)
  assert.equal(clientIp(req('x'.repeat(200)))?.length, 64)
})

test('rate-limit key: a hash of the address, never the address itself', () => {
  const k = ipRateKey('198.51.100.7')
  assert.match(k, /^ip_[0-9a-f]{32}$/)
  assert.equal(k.includes('198.51'), false)
  assert.equal(ipRateKey('198.51.100.7'), k)
  assert.notEqual(ipRateKey('198.51.100.8'), k)
  // A spoofed first hop lands in the same bucket.
  assert.equal(ipRateKey(clientIp(req('9.9.9.9, 198.51.100.7'))), ipRateKey(clientIp(req('8.8.8.8, 198.51.100.7'))))
  assert.equal(ipRateKey(null), ipRateKey('unknown'))
})
