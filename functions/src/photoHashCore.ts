// sharp's types resolve to its ESM build under this CommonJS setup; at
// runtime require('sharp') is the function, so it's typed by hand here.
interface SharpChain {
  rotate(): SharpChain
  greyscale(): SharpChain
  resize(w: number, h: number, o: { fit: 'fill' }): SharpChain
  raw(): SharpChain
  toBuffer(): Promise<Buffer>
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as (input: Buffer) => SharpChain

// T&S Phase 5 — perceptual photo hashes, the pure parts.
//
// A 64-bit difference hash (dHash): the image is shrunk to 9×8 greyscale and
// each bit says whether a pixel is brighter than its right-hand neighbour.
// Resizing, recompressing, small crops or colour tweaks barely change it, so
// near-identical photos land within a few bits of each other.
//
// Search: the hash is split into 4 bands of 16 bits, stored as "<band>:<hex>"
// keys. Two hashes within Hamming distance 8 must agree to within 2 bits on
// at least one band (pigeonhole: 8 ÷ 4), so probing every band value within
// 2 bits of ours finds every candidate; the full distance is then checked.

export const MAX_DISTANCE = 8
const BAND_PROBE_BITS = 2

export async function dHash(bytes: Buffer): Promise<string> {
  const px = await sharp(bytes).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer()
  let bits = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n)
    }
  }
  return bits.toString(16).padStart(16, '0')
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

// "0:ab12", "1:…", "2:…", "3:…"
export function bandKeys(hash: string): string[] {
  return [0, 1, 2, 3].map((i) => `${i}:${hash.slice(i * 4, i * 4 + 4)}`)
}

// Every band key within BAND_PROBE_BITS of this hash's bands (4 × 137).
export function probeKeys(hash: string): string[] {
  const out: string[] = []
  for (let i = 0; i < 4; i++) {
    const v = parseInt(hash.slice(i * 4, i * 4 + 4), 16)
    const near = new Set<number>([v])
    for (let a = 0; a < 16; a++) {
      near.add(v ^ (1 << a))
      if (BAND_PROBE_BITS >= 2) for (let b = a + 1; b < 16; b++) near.add(v ^ (1 << a) ^ (1 << b))
    }
    for (const n of near) out.push(`${i}:${n.toString(16).padStart(4, '0')}`)
  }
  return out
}
