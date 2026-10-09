// Stage 2 Low (b): contact re-request wait (F-097), the device map's daily
// cap (F-097) and the Twilio MessageSid check (F-097).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { MAX_DECLINES, REREQUEST_WAIT_MS, rerequestRefusal } from '../src/contactExchange'
import { NEW_PER_DAY, withinDailyCap, type SightingKind } from '../src/devices'
import { messageSidOf } from '../src/smsInbound'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

test('contact re-request: 24h after a decline or revoke of your own request, then never after 2 declines', () => {
  assert.equal(REREQUEST_WAIT_MS, 24 * HOUR)
  assert.equal(MAX_DECLINES, 2)
  // Nothing yet, or someone else's request: free to ask.
  assert.equal(rerequestRefusal(undefined, 'a', NOW), null)
  assert.equal(rerequestRefusal({ status: 'declined', requestedBy: 'b', respondedAt: NOW - HOUR }, 'a', NOW), null)
  // Declined an hour ago: wait.
  assert.match(rerequestRefusal({ status: 'declined', requestedBy: 'a', respondedAt: NOW - HOUR, declines: { a: 1 } }, 'a', NOW) ?? '', /24 hours/)
  // A day later: allowed again.
  assert.equal(rerequestRefusal({ status: 'declined', requestedBy: 'a', respondedAt: NOW - 25 * HOUR, declines: { a: 1 } }, 'a', NOW), null)
  // Revoked (by either person) an hour ago: wait too.
  assert.match(rerequestRefusal({ status: 'revoked', requestedBy: 'a', revokedAt: NOW - HOUR }, 'a', NOW) ?? '', /24 hours/)
  assert.equal(rerequestRefusal({ status: 'revoked', requestedBy: 'a', revokedAt: NOW - 25 * HOUR }, 'a', NOW), null)
  // Two declines: never again in this conversation — however long ago, and
  // even when the other person asked last. The other person still can.
  const twice = { status: 'declined', requestedBy: 'a', respondedAt: NOW - 30 * 24 * HOUR, declines: { a: 2 } }
  assert.match(rerequestRefusal(twice, 'a', NOW) ?? '', /can't ask again/)
  assert.match(rerequestRefusal({ ...twice, status: 'revoked', requestedBy: 'b' }, 'a', NOW) ?? '', /can't ask again/)
  assert.equal(rerequestRefusal(twice, 'b', NOW), null)
})

test('device map: at most NEW_PER_DAY new values of each kind a day; known ones always pass', () => {
  assert.deepEqual(NEW_PER_DAY, { device: 5, ip: 20, net: 20 })
  const s = (kind: SightingKind, hash: string) => ({ kind, hash })
  // Empty map: up to 5 new devices.
  const many = Array.from({ length: 8 }, (_, i) => s('device', `d${i}`))
  assert.deepEqual(withinDailyCap({}, many, NOW).map((x) => x.hash), ['d0', 'd1', 'd2', 'd3', 'd4'])
  // 4 new today already: room for one more, plus the known one and the IP.
  const seen = Object.fromEntries([0, 1, 2, 3].map((i) => [`d${i}`, { kind: 'device' as const, firstSeen: NOW - HOUR }]))
  const out = withinDailyCap(seen, [s('device', 'd0'), s('device', 'x1'), s('device', 'x2'), s('ip', 'i1')], NOW)
  assert.deepEqual(out.map((x) => x.hash), ['d0', 'x1', 'i1'])
  // Yesterday's don't count against today.
  const old = Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`d${i}`, { kind: 'device' as const, firstSeen: NOW - 25 * HOUR }]))
  assert.equal(withinDailyCap(old, many.slice(5), NOW).length, 3)
})

test('twilio: a MessageSid is checked only when it is well formed', () => {
  assert.equal(messageSidOf({ MessageSid: 'SM0123456789abcdef0123456789abcdef' }), 'SM0123456789abcdef0123456789abcdef')
  assert.equal(messageSidOf({ MessageSid: 'SM1' }), 'SM1')
  assert.equal(messageSidOf({}), null)
  assert.equal(messageSidOf({ MessageSid: '../x' }), null)
  assert.equal(messageSidOf({ MessageSid: 7 }), null)
})
