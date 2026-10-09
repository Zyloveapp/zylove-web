import { createHash } from 'node:crypto'

// The caller's address, for everything that keys on it: IP bans and device
// sightings (devices.ts), the signup-country check (geo.ts), the Terms
// acceptance record (legal.ts), the per-address limits on validatePhoneNumber
// and the contact form.
//
// F-073: the LAST X-Forwarded-For entry — the hop Google's front end appended;
// anything before it is whatever the client sent, so taking the first let
// anyone choose their own address. Not req.ip first either, since Express
// with "trust proxy" on also returns that first hop. req.ip / the socket only
// when there's no header (the emulator, direct calls).

export type RawRequest = { headers?: Record<string, string | string[] | undefined>; ip?: string; socket?: { remoteAddress?: string } } | undefined

export function clientIp(raw: RawRequest): string | null {
  const fwd = raw?.headers?.['x-forwarded-for']
  const hops = (Array.isArray(fwd) ? fwd.join(',') : fwd ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  return (hops[hops.length - 1] || raw?.ip || raw?.socket?.remoteAddress || null)?.slice(0, 64) ?? null
}

// The unit an address is counted by: IPv4 as is, IPv6 by its /64 (F-121,
// M10) — one IPv6 customer gets a whole /64, so per-address limits keyed on
// the full address were effectively unlimited.
export function ipBucket(ip: string | null): string | null {
  if (!ip) return null
  const v = ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip
  if (!v.includes(':')) return v
  // Expand "::" so the first four groups are the real /64.
  const [head, tail = ''] = v.split('::')
  const h = head ? head.split(':') : []
  const t = v.includes('::') ? (tail ? tail.split(':') : []) : []
  const groups = v.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h
  return `${groups.slice(0, 4).map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`
}

// rateLimits/{key} for an address: hashed, never the address itself.
export function ipRateKey(ip: string | null): string {
  return `ip_${createHash('sha256').update(ipBucket(ip) ?? 'unknown').digest('hex').slice(0, 32)}`
}
