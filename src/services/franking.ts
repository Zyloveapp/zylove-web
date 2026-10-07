import { decryptMessage, encryptMessage } from './encryption'

// T&S Phase 4 — message franking, the device half. Same encoding as the
// server's functions/src/frankingCore.ts:
//   c = HMAC-SHA256(kf, "zf1\n" + byteLength(plaintext) + "\n" + plaintext + "\n" + canonical)
//   canonical = JSON.stringify({ cid, matchId, sender, seq })
// kf (fresh, 32 bytes) travels encrypted to the partner as `fk`; c (`fc`)
// goes next to the ciphertext. The recipient's device recomputes c and
// refuses a mismatch; a reporter can reveal plaintext + kf for the messages
// they choose so the server can check them. For photos the plaintext is
// "photo:" + sha256(decrypted bytes).

export interface FrankFields {
  fc: string
  fk: string
  fkn: string
  cid: string
  seq: number
}

const enc = new TextEncoder()
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string) => new Uint8Array(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? [])
function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}
function randomId(): string {
  return btoa(String.fromCharCode(...randomBytes(12))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function canonical(m: { cid: string; matchId: string; sender: string; seq: number }): string {
  return JSON.stringify({ cid: m.cid, matchId: m.matchId, sender: m.sender, seq: m.seq })
}

export async function commitment(kfHex: string, plaintext: string, m: { cid: string; matchId: string; sender: string; seq: number }): Promise<string> {
  const key = await crypto.subtle.importKey('raw', fromHex(kfHex) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const input = enc.encode(`zf1\n${enc.encode(plaintext).length}\n${plaintext}\n${canonical(m)}`)
  return hex(await crypto.subtle.sign('HMAC', key, input as BufferSource))
}

export async function photoPlaintext(bytes: Uint8Array): Promise<string> {
  return `photo:${hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))}`
}

// The fields to send with a message, or null when it can't be franked
// (no keys — then nothing is sent anyway).
export async function frank(input: { plaintext: string; matchId: string; sender: string; seq: number; partnerPublicKey: string; myPrivateKey: string }): Promise<FrankFields | null> {
  const kf = hex(randomBytes(32))
  const sealed = encryptMessage(kf, input.partnerPublicKey, input.myPrivateKey)
  if (sealed.nonce === 'stub') return null
  const cid = randomId()
  const fc = await commitment(kf, input.plaintext, { cid, matchId: input.matchId, sender: input.sender, seq: input.seq })
  return { fc, fk: sealed.ciphertext, fkn: sealed.nonce, cid, seq: input.seq }
}

// The message's kf, opened with this device's keys (null if it has none).
export function revealKf(m: { fk?: string; fkn?: string }, partnerPublicKey: string, myPrivateKey: string): string | null {
  if (!m.fk || !m.fkn) return null
  const kf = decryptMessage(m.fk, m.fkn, partnerPublicKey, myPrivateKey)
  return kf && /^[a-f0-9]{64}$/.test(kf) ? kf : null
}

// 'ok' (commitment checks out), 'bad' (it doesn't — refuse the message) or
// 'none' (sent before franking, or no commitment).
export async function checkFrank(
  m: { fc?: string; fk?: string; fkn?: string; cid?: string; seq?: number; senderId: string },
  plaintext: string,
  matchId: string,
  partnerPublicKey: string,
  myPrivateKey: string,
): Promise<'ok' | 'bad' | 'none'> {
  if (!m.fc || !m.cid || typeof m.seq !== 'number') return 'none'
  const kf = revealKf(m, partnerPublicKey, myPrivateKey)
  if (!kf) return 'bad'
  return (await commitment(kf, plaintext, { cid: m.cid, matchId, sender: m.senderId, seq: m.seq })) === m.fc ? 'ok' : 'bad'
}
