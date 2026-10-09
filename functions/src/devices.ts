import { createHmac } from 'node:crypto'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { clientIp } from './clientIp'
import { recordCountryCheck } from './geo'
const isBotUid = (uid: string): boolean => /^(zbot|seed)-/.test(uid)

// T&S Phase 1 — device and network signals.
//
// The app sends a random device id once per session (recordDevice); the
// server adds the caller's IP and its network (/24 for IPv4, /48 for IPv6).
// Every value is stored only as HMAC-SHA256 under TRUST_HASH_KEY (a plain
// hash of an IPv4 address could be reversed by trying them all):
//   userDevices/{uid}       { seen: { [hash]: { kind, firstSeen, lastSeen, ua } } }
//   deviceSightings/{hash}  { kind, uids: { [uid]: lastSeen }, firstSeen }
//   bannedDevices/{hash}    { kind, uids, at } — a banned account's hashes,
//                           kept as long as the ban stands
// Sightings are kept SIGHTING_KEEP_MS (purgeDeviceSightings). Same device
// across accounts is a strong signal; same IP is weak (and ignored for
// networks shared by many accounts — carriers, campuses, Private Relay).

export const TRUST_HASH_KEY = defineSecret('TRUST_HASH_KEY')
export const SIGHTING_KEEP_MS = 90 * 24 * 60 * 60 * 1000
const RESIGHT_MS = 60 * 60 * 1000 // a session re-reports at most hourly
export type SightingKind = 'device' | 'ip' | 'net'

const db = () => getFirestore()

export function hashValue(kind: SightingKind, value: string, key = TRUST_HASH_KEY.value()): string {
  return createHmac('sha256', key).update(`${kind}:${value}`).digest('hex')
}

// 203.0.113.7 → 203.0.113.0/24; 2001:db8:1:2::5 → 2001:db8:1::/48.
export function networkOf(ip: string): string | null {
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/)
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`
  if (ip.includes(':')) {
    const full = ip.split('::')
    const head = full[0].split(':').filter(Boolean)
    const tail = full.length > 1 ? full[1].split(':').filter(Boolean) : []
    const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
    if (groups.length < 3) return null
    return `${groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16)).join(':')}::/48`
  }
  return null
}

// "iOS Safari", "Android Chrome", "Mac Chrome"… — coarse, for context only.
export function uaFamily(ua: string): string {
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other'
  const browser = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Other'
  return `${os} ${browser}`
}

export const recordDevice = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public', secrets: [TRUST_HASH_KEY] },
  async (request): Promise<{ ok: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const deviceId = (request.data as Record<string, unknown> | null)?.deviceId
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(deviceId)) throw new HttpsError('invalid-argument', 'deviceId required')
    // F-073: the hop Google appended, not one the client sent.
    const ip = clientIp(request.rawRequest as never)
    const uaHeader = request.rawRequest?.headers?.['user-agent']
    const ua = uaFamily(typeof uaHeader === 'string' ? uaHeader : '')
    const values: [SightingKind, string][] = [['device', deviceId]]
    if (ip) {
      values.push(['ip', ip])
      const net = networkOf(ip)
      if (net) values.push(['net', net])
    }
    await recordSightings(uid, values.map(([kind, v]) => ({ kind, hash: hashValue(kind, v) })), ua)
    // T&S Phase 2: the account's signup country, once (country only).
    await recordCountryCheck(uid, ip).catch((err: unknown) => logger.warn('recordDevice: country check failed', { message: err instanceof Error ? err.message : String(err) }))
    return { ok: true }
  },
)

// F-097: at most this many NEW values of each kind per account per day
// (first seen in the last 24 hours) — a script sending made-up device ids
// can't grow its map, or the sightings index, without bound. Addresses
// change more often (mobile networks), so they get more room.
export const NEW_PER_DAY: Record<SightingKind, number> = { device: 5, ip: 20, net: 20 }
const DAY_MS = 24 * 60 * 60 * 1000

// The sightings to record: those already on the map, plus new ones while
// their kind has room today. Pure.
export function withinDailyCap<S extends { kind: SightingKind; hash: string }>(
  seen: Record<string, { kind: SightingKind; firstSeen: number }>,
  sightings: S[],
  now: number,
): S[] {
  const room = { ...NEW_PER_DAY }
  for (const s of Object.values(seen)) if (now - s.firstSeen < DAY_MS && s.kind in room) room[s.kind]--
  return sightings.filter((s) => {
    if (seen[s.hash]) return true
    if (room[s.kind] <= 0) return false
    room[s.kind]--
    return true
  })
}

export async function recordSightings(uid: string, sightings: { kind: SightingKind; hash: string }[], ua: string): Promise<void> {
  const now = Date.now()
  const mine = db().doc(`userDevices/${uid}`)
  const seen = ((await mine.get()).data()?.seen ?? {}) as Record<string, { kind: SightingKind; firstSeen: number; lastSeen: number; ua?: string }>
  const admitted = withinDailyCap(seen, sightings, now)
  if (admitted.length < sightings.length) logger.warn('recordDevice: daily cap on new devices/addresses reached', { dropped: sightings.length - admitted.length })
  const fresh = admitted.filter((s) => !(seen[s.hash] && now - seen[s.hash].lastSeen < RESIGHT_MS))
  if (!fresh.length) return
  const batch = db().batch()
  for (const s of fresh) {
    batch.set(
      mine,
      { seen: { [s.hash]: { kind: s.kind, firstSeen: seen[s.hash]?.firstSeen ?? now, lastSeen: now, ua } }, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    )
    batch.set(
      db().doc(`deviceSightings/${s.hash}`),
      { kind: s.kind, uids: { [uid]: now }, firstSeen: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    )
  }
  await batch.commit()
  // A banned account's device (strong) or network address (weak).
  const banned = await db().getAll(...fresh.filter((s) => s.kind !== 'net').map((s) => db().doc(`bannedDevices/${s.hash}`)))
  const hits = banned.filter((d) => d.exists).map((d) => (d.data() as DocumentData).kind as SightingKind)
  if (hits.length) {
    await db()
      .doc(`behaviorSignals/${uid}`)
      .set(
        {
          bannedDeviceMatch: hits.includes('device') ? { at: now } : FieldValue.delete(),
          bannedIpMatch: hits.includes('ip') ? { at: now } : FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
    logger.warn('recordDevice: banned account device/IP seen on another account', { device: hits.includes('device'), ip: hits.includes('ip') })
  }
}

// Other accounts seen on this account's devices and addresses (last 90 days).
// With networks: on its /24 (/48) networks too — a weaker link, used where a
// false "unlinked" costs more than a false "linked" (scam reporters, F-074).
export interface LinkedAccount {
  uid: string
  via: SightingKind[]
}
const SHARED_NETWORK_AT = 10 // more accounts than this on one address: a shared network

export async function linkedAccounts(uid: string, { networks = false } = {}): Promise<LinkedAccount[]> {
  const now = Date.now()
  const seen = ((await db().doc(`userDevices/${uid}`).get()).data()?.seen ?? {}) as Record<string, { kind: SightingKind; lastSeen: number }>
  const hashes = Object.entries(seen).filter(([, s]) => now - s.lastSeen < SIGHTING_KEEP_MS && (networks || s.kind !== 'net'))
  if (!hashes.length) return []
  const docs = await db().getAll(...hashes.map(([h]) => db().doc(`deviceSightings/${h}`)))
  const out = new Map<string, Set<SightingKind>>()
  docs.forEach((d, i) => {
    const kind = hashes[i][1].kind
    const uids = Object.entries((d.data()?.uids ?? {}) as Record<string, number>).filter(([, at]) => now - at < SIGHTING_KEEP_MS).map(([u]) => u)
    if (kind !== 'device' && uids.length > SHARED_NETWORK_AT) return
    for (const other of uids) {
      if (other === uid || isBotUid(other)) continue
      if (!out.has(other)) out.set(other, new Set())
      out.get(other)!.add(kind)
    }
  })
  return [...out].map(([u, via]) => ({ uid: u, via: [...via] }))
}

// On a ban: the account's device and IP hashes, kept while the ban stands.
export async function markBannedDevices(uid: string): Promise<number> {
  const seen = ((await db().doc(`userDevices/${uid}`).get()).data()?.seen ?? {}) as Record<string, { kind: SightingKind }>
  const entries = Object.entries(seen).filter(([, s]) => s.kind === 'device' || s.kind === 'ip')
  const batch = db().batch()
  for (const [hash, s] of entries) {
    batch.set(db().doc(`bannedDevices/${hash}`), { kind: s.kind, uids: FieldValue.arrayUnion(uid), at: FieldValue.serverTimestamp() }, { merge: true })
  }
  if (entries.length) await batch.commit()
  return entries.length
}

// An account's sightings, removed on deletion (clearPrivateData).
export async function removeDeviceData(uid: string): Promise<void> {
  const ref = db().doc(`userDevices/${uid}`)
  const seen = ((await ref.get()).data()?.seen ?? {}) as Record<string, unknown>
  await Promise.all(Object.keys(seen).map((h) => db().doc(`deviceSightings/${h}`).update({ [`uids.${uid}`]: FieldValue.delete() }).catch(() => {})))
  await ref.delete()
}

// Sightings older than 90 days go (nightly); banned hashes stay.
export const purgeDeviceSightings = onSchedule(
  { schedule: '55 2 * * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const cutoff = Date.now() - SIGHTING_KEEP_MS
    let pruned = 0
    for (const d of (await db().collection('userDevices').get()).docs) {
      const seen = (d.data().seen ?? {}) as Record<string, { lastSeen: number }>
      const old = Object.entries(seen).filter(([, s]) => s.lastSeen < cutoff).map(([h]) => h)
      if (old.length === Object.keys(seen).length) await d.ref.delete()
      else if (old.length) await d.ref.update(Object.fromEntries(old.map((h) => [`seen.${h}`, FieldValue.delete()])))
      pruned += old.length
    }
    for (const d of (await db().collection('deviceSightings').get()).docs) {
      const uids = (d.data().uids ?? {}) as Record<string, number>
      const old = Object.entries(uids).filter(([, at]) => at < cutoff).map(([u]) => u)
      if (old.length === Object.keys(uids).length) await d.ref.delete()
      else if (old.length) await d.ref.update(Object.fromEntries(old.map((u) => [`uids.${u}`, FieldValue.delete()])))
    }
    logger.info('purgeDeviceSightings', { pruned })
  },
)
