// T&S Phase 1 — duplicate-opener check, computed on the sender's device.
// Only a keyed hash of a normalized first message (20+ characters) leaves
// the device — never the text. The server compares hashes across chats to
// spot the same opener pasted to many people, keeps them 14 days, and drops
// the hash from the message once it's counted (functions/src/trustSignals.ts).

const KEY = 'zylove-opener-v1'
export const MIN_OPENER_CHARS = 20

// Lowercase, the recipient's name taken out (copy-paste openers are often
// personalized with it), letters and digits only, spaces collapsed.
export function normalizeOpener(text: string, recipientName: string): string {
  let t = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  for (const part of recipientName.toLowerCase().split(/\s+/).filter((p) => p.length >= 2)) {
    t = t.split(part).join(' ')
  }
  return t.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
}

// The hash for an opener, or null when it's too short to mean anything.
export async function openerHash(text: string, recipientName: string): Promise<string | null> {
  const norm = normalizeOpener(text, recipientName)
  if (norm.length < MIN_OPENER_CHARS || typeof crypto?.subtle === 'undefined') return null
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(norm)))
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('')
}
