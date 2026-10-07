import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

// T&S Phase 4 — message franking, the pure parts (the approved design in the
// T&S plan; the app's copy is src/services/franking.ts — same encoding).
//
// NaCl box isn't key-committing, so each message also carries a commitment:
//   c = HMAC-SHA256(kf, "zf1\n" + byteLength(plaintext) + "\n" + plaintext + "\n" + canonical)
//   canonical = JSON.stringify({ cid, matchId, sender, seq })   (that key order)
// kf is a fresh 32-byte key per message, sent inside the encryption (only the
// two people can read it). For a photo, plaintext = "photo:" + sha256(bytes).
// The server binds c to the authenticated sender, the match, the message and
// its own clock with a key only it holds:
//   r = HMAC-SHA256(K_server, "zr1\n" + c + "\n" + sender + "\n" + matchId + "\n" + msgId + "\n" + atMs)
// A reporter later reveals plaintext + kf for the messages they choose; the
// server recomputes c and r. Anything that doesn't check out is shown as
// unverified (older messages have no c at all).

export interface FrankMeta {
  cid: string
  matchId: string
  sender: string
  seq: number
}

export function canonical(m: FrankMeta): string {
  return JSON.stringify({ cid: m.cid, matchId: m.matchId, sender: m.sender, seq: m.seq })
}

export function commitmentInput(plaintext: string, m: FrankMeta): Buffer {
  return Buffer.from(`zf1\n${Buffer.byteLength(plaintext, 'utf8')}\n${plaintext}\n${canonical(m)}`, 'utf8')
}

export function commitment(kfHex: string, plaintext: string, m: FrankMeta): string {
  return createHmac('sha256', Buffer.from(kfHex, 'hex')).update(commitmentInput(plaintext, m)).digest('hex')
}

export const photoPlaintext = (bytes: Buffer) => `photo:${createHash('sha256').update(bytes).digest('hex')}`

export function serverTag(keyHex: string, c: string, sender: string, matchId: string, msgId: string, atMs: number): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`zr1\n${c}\n${sender}\n${matchId}\n${msgId}\n${atMs}`).digest('hex')
}

export function sameHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

// A versioned key secret: "v2:<64 hex>,v1:<64 hex>" (newest first), or just
// "<64 hex>" (= v1). Rotation adds a new version in front; older ones stay
// so earlier tags still verify.
export function parseKeys(secret: string): { v: string; key: string }[] {
  const keys = secret
    .trim()
    .split(',')
    .map((part, i) => {
      const m = part.trim().match(/^(?:(v\d+):)?([a-f0-9]{64})$/i)
      return m ? { v: m[1] ?? (i === 0 ? 'v1' : `v${i + 1}`), key: m[2].toLowerCase() } : null
    })
    .filter((k): k is { v: string; key: string } => k !== null)
  if (!keys.length) throw new Error('key secret must be 64 hex characters (optionally "v1:" prefixed, comma-separated for rotation)')
  return keys
}

export type Verdict = 'verified' | 'unverified' | 'mismatch'

// One reported message: what the reporter revealed vs what's on record.
export function verifyItem(input: {
  revealed: { plaintext: string; kf: string | null }
  message: { fc?: unknown; cid?: unknown; seq?: unknown; senderId: string }
  matchId: string
  msgId: string
  tag: { r: string; v: string; at: number; sender: string } | null
  keys: { v: string; key: string }[]
}): Verdict {
  const { revealed, message: m, matchId, msgId, tag, keys } = input
  if (typeof m.fc !== 'string' || typeof m.cid !== 'string' || typeof m.seq !== 'number') return 'unverified' // sent before franking
  if (!revealed.kf || !/^[a-f0-9]{64}$/.test(revealed.kf)) return 'mismatch'
  const c = commitment(revealed.kf, revealed.plaintext, { cid: m.cid, matchId, sender: m.senderId, seq: m.seq })
  if (!sameHex(c, m.fc)) return 'mismatch'
  if (!tag) return 'unverified' // no server tag on record
  const key = keys.find((k) => k.v === tag.v)
  if (!key || tag.sender !== m.senderId) return 'mismatch'
  return sameHex(serverTag(key.key, m.fc, tag.sender, matchId, msgId, tag.at), tag.r) ? 'verified' : 'mismatch'
}
