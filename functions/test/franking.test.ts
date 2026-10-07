// T&S Phase 4 — franking commitments and tags, locker sealing and retention.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomBytes } from 'node:crypto'
import { canonical, commitment, parseKeys, photoPlaintext, serverTag, verifyItem } from '../src/frankingCore'
import { DAY_MS, deletable, expiryFor, open, seal } from '../src/lockerCore'

const K = parseKeys('v2:' + 'b'.repeat(64) + ',v1:' + 'a'.repeat(64))
const kf = randomBytes(32).toString('hex')
const meta = { cid: 'cid123', matchId: 'm_1', sender: 'alice', seq: 4 }

function onRecord(text: string, at = 1_700_000_000_000) {
  const fc = commitment(kf, text, meta)
  return { message: { fc, cid: meta.cid, seq: meta.seq, senderId: meta.sender }, tag: { r: serverTag(K[0].key, fc, 'alice', 'm_1', 'msg1', at), v: 'v2', at, sender: 'alice' } }
}

test('canonical metadata has a fixed key order', () => {
  assert.equal(canonical({ seq: 1, sender: 's', matchId: 'm', cid: 'c' } as never), '{"cid":"c","matchId":"m","sender":"s","seq":1}')
})

test('a genuine reveal verifies', () => {
  const { message, tag } = onRecord('hello there')
  assert.equal(verifyItem({ revealed: { plaintext: 'hello there', kf }, message, matchId: 'm_1', msgId: 'msg1', tag, keys: K }), 'verified')
})

test('tampered text, a wrong kf, a misattributed sender or another message all fail', () => {
  const { message, tag } = onRecord('hello there')
  const base = { message, matchId: 'm_1', msgId: 'msg1', tag, keys: K }
  assert.equal(verifyItem({ ...base, revealed: { plaintext: 'hello there!', kf } }), 'mismatch') // edited text
  assert.equal(verifyItem({ ...base, revealed: { plaintext: 'hello there', kf: randomBytes(32).toString('hex') } }), 'mismatch')
  assert.equal(verifyItem({ ...base, revealed: { plaintext: 'hello there', kf: null } }), 'mismatch')
  // Claimed it came from Bob: the commitment binds the sender.
  assert.equal(verifyItem({ ...base, message: { ...message, senderId: 'bob' }, revealed: { plaintext: 'hello there', kf } }), 'mismatch')
  // The server tag binds the message id and the sender.
  assert.equal(verifyItem({ ...base, msgId: 'msg2', revealed: { plaintext: 'hello there', kf } }), 'mismatch')
  assert.equal(verifyItem({ ...base, tag: { ...tag, sender: 'bob' }, revealed: { plaintext: 'hello there', kf } }), 'mismatch')
})

test('messages sent before franking are "unverified", not failures; rotation keeps old tags valid', () => {
  assert.equal(verifyItem({ revealed: { plaintext: 'old', kf: null }, message: { senderId: 'alice' }, matchId: 'm_1', msgId: 'x', tag: null, keys: K }), 'unverified')
  const fc = commitment(kf, 'hi', meta)
  const old = { r: serverTag(K[1].key, fc, 'alice', 'm_1', 'msg1', 5), v: 'v1', at: 5, sender: 'alice' }
  assert.equal(verifyItem({ revealed: { plaintext: 'hi', kf }, message: { fc, cid: meta.cid, seq: meta.seq, senderId: 'alice' }, matchId: 'm_1', msgId: 'msg1', tag: old, keys: K }), 'verified')
})

test('photos: the commitment covers the decrypted bytes', () => {
  const bytes = randomBytes(1000)
  const fc = commitment(kf, photoPlaintext(bytes), meta)
  const message = { fc, cid: meta.cid, seq: meta.seq, senderId: 'alice' }
  const tag = { r: serverTag(K[0].key, fc, 'alice', 'm_1', 'p1', 9), v: 'v2', at: 9, sender: 'alice' }
  assert.equal(verifyItem({ revealed: { plaintext: photoPlaintext(bytes), kf }, message, matchId: 'm_1', msgId: 'p1', tag, keys: K }), 'verified')
  const other = Buffer.from(bytes); other[0] ^= 1
  assert.equal(verifyItem({ revealed: { plaintext: photoPlaintext(other), kf }, message, matchId: 'm_1', msgId: 'p1', tag, keys: K }), 'mismatch')
})

test('keys: plain hex is v1; garbage is refused', () => {
  assert.deepEqual(parseKeys('c'.repeat(64)), [{ v: 'v1', key: 'c'.repeat(64) }])
  assert.throws(() => parseKeys('not-a-key'))
})

test('locker: sealed with the newest key, opens with any listed key, tampering is detected', () => {
  const s = seal(K, { items: [{ text: 'secret' }] })
  assert.equal(s.v, 'v2')
  assert.ok(!Buffer.from(s.data, 'base64').toString('utf8').includes('secret'))
  assert.deepEqual(open(K, s), { items: [{ text: 'secret' }] })
  const bad = { ...s, data: Buffer.from('x' + Buffer.from(s.data, 'base64').toString('latin1').slice(1), 'latin1').toString('base64') }
  assert.throws(() => open(K, bad))
})

test('retention: 30 days after decision, 1 year for NCMEC, paused by an appeal, held items never deleted', () => {
  const t = 1_700_000_000_000
  assert.equal(expiryFor({ createdAt: t, decidedAt: t + DAY_MS, ncmec: false, appealPending: false }), t + 31 * DAY_MS)
  assert.equal(expiryFor({ createdAt: t, decidedAt: t, ncmec: true, appealPending: false }), t + 365 * DAY_MS)
  assert.equal(expiryFor({ createdAt: t, decidedAt: t, ncmec: false, appealPending: true }), null)
  assert.equal(expiryFor({ createdAt: t, decidedAt: null, ncmec: false, appealPending: false }), t + 180 * DAY_MS)
  assert.equal(deletable({ expiresAt: t, legalHold: null }, t + 1), true)
  assert.equal(deletable({ expiresAt: t, legalHold: { by: 'admin' } }, t + 1), false)
  assert.equal(deletable({ expiresAt: null, legalHold: null }, t + 1), false)
})
