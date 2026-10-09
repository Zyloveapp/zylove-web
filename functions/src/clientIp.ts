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

// rateLimits/{key} for an address: hashed, never the address itself.
export function ipRateKey(ip: string | null): string {
  return `ip_${createHash('sha256').update(ip ?? 'unknown').digest('hex').slice(0, 32)}`
}
