import { gunzipSync } from 'node:zlib'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { getStorage } from 'firebase-admin/storage'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { Reader, type CountryResponse } from 'mmdb-lib'
import { parsePhoneNumberFromString } from 'libphonenumber-js'
import { ZYLOVE_CITIES } from './cities'
import { loadLocation } from './userData'

// T&S Phase 2 — signup country. The country (only — never the address) of
// the IP an account is first seen from, from MaxMind's GeoLite2 Country
// database read inside the function, plus the phone number's country:
//   userInternal/{uid}.countryCheck { ip, phone, city, at }   (once)
//   behaviorSignals/{uid}.countryMismatch { text, at }        when they disagree
// A disagreement is a flag for human review (trustScore.ts), nothing more.
//
// The database lives at GEO_PATH in the default bucket (server-only) and is
// refreshed weekly by refreshGeoDb from MaxMind with MAXMIND_CREDENTIALS
// ("<account id>:<license key>"); old copies are overwritten, as the GeoLite
// licence requires. Until the first download, the IP country is just unknown.

export const MAXMIND_CREDENTIALS = defineSecret('MAXMIND_CREDENTIALS')
export const GEO_PATH = 'system/geo/GeoLite2-Country.mmdb'
const RELOAD_MS = 24 * 60 * 60 * 1000
const db = () => getFirestore()

let cached: { reader: Reader<CountryResponse> | null; at: number } | null = null

async function reader(): Promise<Reader<CountryResponse> | null> {
  if (cached && Date.now() - cached.at < RELOAD_MS) return cached.reader
  try {
    const file = getStorage().bucket().file(GEO_PATH)
    const [exists] = await file.exists()
    cached = { reader: exists ? new Reader<CountryResponse>((await file.download())[0]) : null, at: Date.now() }
  } catch (err) {
    logger.warn('geo: database unavailable', { message: err instanceof Error ? err.message : String(err) })
    cached = { reader: null, at: Date.now() }
  }
  return cached.reader
}

export async function countryOfIp(ip: string | null): Promise<string | null> {
  if (!ip) return null
  try {
    return (await reader())?.get(ip)?.country?.iso_code ?? null
  } catch {
    return null
  }
}

// A number that doesn't pin down one country (an unassigned NANP area code,
// a test range) counts as its calling code's main country (+1 → US, +44 → GB).
export function countryOfPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const p = parsePhoneNumberFromString(phone)
  if (!p) return null
  return p.country ?? p.getPossibleCountries()[0] ?? (p.countryCallingCode === '1' ? 'US' : null)
}

// Every launch city is in the US.
export function countryOfCity(marketCityId: string | null | undefined): string | null {
  return marketCityId && ZYLOVE_CITIES.some((c) => c.id === marketCityId) ? 'US' : null
}

// A short description when any two known countries disagree, else null.
export function countryDisagreement(c: { ip: string | null; phone: string | null; city: string | null }): string | null {
  const known = [c.ip, c.phone, c.city].filter((x): x is string => !!x)
  if (new Set(known).size <= 1) return null
  return [c.ip && `IP: ${c.ip}`, c.phone && `phone: ${c.phone}`, c.city && `city: ${c.city}`].filter(Boolean).join(' · ')
}

// Once per account, from recordDevice (which has the caller's IP).
export async function recordCountryCheck(uid: string, ip: string | null): Promise<void> {
  const internal = db().doc(`userInternal/${uid}`)
  if ((await internal.get()).data()?.countryCheck) return
  const [ipCountry, user, loc] = await Promise.all([
    countryOfIp(ip),
    getAuth()
      .getUser(uid)
      .catch(() => null),
    loadLocation(uid).catch(() => null),
  ])
  const check = { ip: ipCountry, phone: countryOfPhone(user?.phoneNumber), city: countryOfCity(loc?.marketCityId) }
  await internal.set({ countryCheck: { ...check, at: Date.now() } }, { merge: true })
  const text = countryDisagreement(check)
  if (text) {
    await db().doc(`behaviorSignals/${uid}`).set({ countryMismatch: { text, at: Date.now() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  }
}

// ─── The database ────────────────────────────────────────────────────────────

// The first *.mmdb in a tar archive (ustar; enough for MaxMind's).
export function mmdbFromTar(tar: Buffer): Buffer | null {
  let off = 0
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const field = (a: number, b: number) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '')
    const name = `${field(345, 500)}${field(345, 500) ? '/' : ''}${field(0, 100)}`
    const size = parseInt(field(124, 136).trim() || '0', 8)
    const type = field(156, 157)
    off += 512
    if ((type === '0' || type === '') && name.endsWith('.mmdb')) return Buffer.from(tar.subarray(off, off + size))
    off += Math.ceil(size / 512) * 512
  }
  return null
}

export const refreshGeoDb = onSchedule(
  { schedule: '30 4 * * 3', timeZone: 'America/Chicago', timeoutSeconds: 300, memory: '512MiB', secrets: [MAXMIND_CREDENTIALS] },
  async () => {
    const creds = MAXMIND_CREDENTIALS.value().trim()
    if (!creds.includes(':')) {
      logger.error('refreshGeoDb: MAXMIND_CREDENTIALS must be "<account id>:<license key>"')
      return
    }
    const res = await fetch('https://download.maxmind.com/geoip/databases/GeoLite2-Country/download?suffix=tar.gz', {
      headers: { Authorization: `Basic ${Buffer.from(creds).toString('base64')}` },
    })
    if (!res.ok) {
      logger.error('refreshGeoDb: download failed', { status: res.status })
      return
    }
    const mmdb = mmdbFromTar(gunzipSync(Buffer.from(await res.arrayBuffer())))
    // Sanity check before replacing the copy in use.
    if (!mmdb || new Reader<CountryResponse>(mmdb).get('8.8.8.8')?.country?.iso_code !== 'US') {
      logger.error('refreshGeoDb: the download did not contain a usable database')
      return
    }
    await getStorage().bucket().file(GEO_PATH).save(mmdb, { contentType: 'application/octet-stream', resumable: false })
    cached = null
    logger.info('refreshGeoDb', { bytes: mmdb.length })
  },
)
