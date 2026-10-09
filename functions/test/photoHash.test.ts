// T&S Phase 5 — perceptual hashes: near copies match, different photos don't,
// and the band probes find every pair within the distance.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { MAX_DISTANCE, bandKeys, dHash, firstUploads, hamming, newerUploader, probeKeys } from '../src/photoHashCore'
import { FLAG_AT, featuresOf, scoreFeatures } from '../src/trustScore'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp')

// A synthetic "photo": soft gradients and shapes, as JPEG.
async function photo(seed: number, opts: { w?: number; h?: number; quality?: number; brighten?: number } = {}): Promise<Buffer> {
  const w = opts.w ?? 320
  const h = opts.h ?? 400
  const px = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const v = 128 + 60 * Math.sin((x / w) * Math.PI * (2 + (seed % 3))) + 50 * Math.cos((y / h) * Math.PI * (1 + (seed % 4))) + (((x - w / 2) ** 2 + (y - h / 3) ** 2 < (w / 5) ** 2) ? 40 * (seed % 2 ? 1 : -1) : 0)
      const b = Math.max(0, Math.min(255, v + (opts.brighten ?? 0)))
      px[i] = b
      px[i + 1] = Math.max(0, Math.min(255, b - 20 + seed))
      px[i + 2] = Math.max(0, Math.min(255, b + 10))
    }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: opts.quality ?? 85 }).toBuffer()
}

test('a 64-bit hash, 16 hex characters', async () => {
  assert.match(await dHash(await photo(1)), /^[a-f0-9]{16}$/)
})

test('resized, recompressed or slightly brightened copies stay within the distance', async () => {
  const original = await dHash(await photo(1))
  for (const copy of [await photo(1, { w: 160, h: 200 }), await photo(1, { quality: 40 }), await photo(1, { brighten: 15 })]) {
    assert.ok(hamming(original, await dHash(copy)) <= MAX_DISTANCE)
  }
})

test('different photos are far apart', async () => {
  assert.ok(hamming(await dHash(await photo(1)), await dHash(await photo(2))) > MAX_DISTANCE)
})

test('hamming distance', () => {
  assert.equal(hamming('0000000000000000', '0000000000000000'), 0)
  assert.equal(hamming('0000000000000000', 'ffffffffffffffff'), 64)
  assert.equal(hamming('0000000000000001', '0000000000000003'), 1)
})

test('band probes find every hash within distance 8 (and band keys are positional)', () => {
  assert.deepEqual(bandKeys('0123456789abcdef'), ['0:0123', '1:4567', '2:89ab', '3:cdef'])
  const base = 'a5c3f00f1234beef'
  const probes = new Set(probeKeys(base))
  assert.equal(probes.size, 4 * 137)
  // Flip up to 8 bits spread as evenly as possible (the worst case: 2 per band).
  for (let trial = 0; trial < 200; trial++) {
    let x = BigInt(`0x${base}`)
    const bits = new Set<number>()
    while (bits.size < 8) bits.add(Math.floor(Math.random() * 64))
    for (const b of bits) x ^= 1n << BigInt(b)
    const other = x.toString(16).padStart(16, '0')
    assert.ok(bandKeys(other).some((k) => probes.has(k)), `missed ${other}`)
  }
})

test('risk score: a duplicate photo alone stays under the flag (F-087) but adds up; a blocklist match flags strongly', () => {
  const dup = scoreFeatures(featuresOf({ signals: { duplicatePhotos: { accounts: 1 } } }), null)
  assert.ok(dup.score < FLAG_AT)
  assert.equal(dup.reasons[0].key, 'duplicate_photo')
  assert.equal(dup.reasons[0].points, 25)
  assert.match(dup.reasons[0].text, /near-same photo as 1 other account that had it first/)
  const withDevice = scoreFeatures({ ...featuresOf({ signals: { duplicatePhotos: { accounts: 1 } } }), sharedDeviceAccounts: 1 }, null)
  assert.ok(withDevice.score >= FLAG_AT)
  const bl = scoreFeatures(featuresOf({ signals: { blocklistPhoto: { at: 1 } } }), null)
  assert.equal(bl.reasons[0].key, 'blocklist_photo')
  assert.ok(bl.score >= FLAG_AT)
})

test('duplicates count against the newer uploader only (F-087)', () => {
  // The copier uploads now; the owner had it earlier.
  assert.equal(newerUploader({ uid: 'copier', at: 2000 }, { uid: 'owner', at: 1000 }), 'copier')
  // The owner re-uploads their own photo after someone copied it: their
  // first copy still decides.
  const first = firstUploads([
    { uid: 'owner', at: 1000 },
    { uid: 'copier', at: 2000 },
    { uid: 'owner', at: 3000 },
    { uid: 'old', at: undefined },
  ])
  assert.equal(first.get('owner'), 1000)
  assert.equal(first.has('old'), false)
  assert.equal(newerUploader({ uid: 'owner', at: first.get('owner') ?? null }, { uid: 'copier', at: first.get('copier') ?? null }), 'copier')
  // A record from before upload times counts as the earlier; a tie is the uploader's.
  assert.equal(newerUploader({ uid: 'me', at: 5 }, { uid: 'them', at: null }), 'me')
  assert.equal(newerUploader({ uid: 'me', at: null }, { uid: 'them', at: 5 }), 'them')
  assert.equal(newerUploader({ uid: 'me', at: 5 }, { uid: 'them', at: 5 }), 'me')
})
