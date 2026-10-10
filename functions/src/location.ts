import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { distanceMiles, getLinkedCity, getNearestCity } from './cities'
import { marketFor } from './trial'
import { accountRef, identityRef, internalRef, isDeletedUid, locationRef, userRef, requireActive } from './userData'
import { takeRateLimit } from './rateLimits'
import { isPlayId, uidOfPlayId } from './playIds'
import { hiddenInMode } from './blockCore'
import { distanceAllowed, isHiddenVisibility, matchIsLive } from './distanceCore'
import { tierNow } from './entitlements'
import {
  SMS_CONSENT_SOURCES,
  SMS_CONSENT_TEXTS,
  SMS_SECRETS,
  optOutRef,
  sendConsentConfirmation,
  smsFromNumber,
  type Delivery,
  type SmsConsentSource,
} from './sms'

// Locations, server-side (Stage 1a). Nobody reads another user's coordinates:
// the browser's position goes to setLocation, which snaps it and keeps it in
// userLocations/{uid} (server-only); the app asks getDistances for how far
// away people are and gets whole miles back, never coordinates.

// ~1 mile of latitude (Stage 3; was 0.05°, ~3.5 mi). Both ends of every
// distance are snapped to it; locations saved before keep their coarser grid
// until the next save.
const GRID_DEG = 0.015
const MAX_CHANGES_PER_DAY = 3
const DAY_MS = 24 * 60 * 60 * 1000
// F-125 (M14): every setLocation call, moved or not — each one can reach
// the reverse geocoder (OpenStreetMap asks for at most 1 request a second).
const SET_LOCATION_PER_HOUR = 10
export const LOCATION_LIMIT_MESSAGE = 'You can update your location again tomorrow'

function snap(v: number): number {
  return Math.round(Math.round(v / GRID_DEG) * GRID_DEG * 1000) / 1000
}

function coord(v: unknown, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) throw new HttpsError('invalid-argument', 'Invalid location')
  return v
}

// "Austin, TX" from OpenStreetMap's reverse geocoder, or null on any failure.
async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10&addressdetails=1`
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Zylove/1.0 (https://zylove.app)' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data: unknown = await res.json()
    const address = (data as { address?: Record<string, string> }).address ?? {}
    const city = address.city ?? address.town ?? address.village ?? address.municipality ?? address.county
    // ISO3166-2-lvl4 is "US-TX"; fall back to the full state name.
    const code = address['ISO3166-2-lvl4']
    const state = code?.includes('-') ? code.split('-')[1] : address.state
    const label = city ? (state ? `${city}, ${state}` : city) : (state ?? null)
    return label ? label.slice(0, 80) : null
  } catch {
    return null
  }
}

// ─── setLocation ─────────────────────────────────────────────────────────────

// Saves the caller's location: snapped to the grid, labelled ("Austin, TX"),
// with the launch market it's in (or the city it's linked to). A position in the
// same grid cell as the saved one changes nothing and isn't counted; real
// moves are limited to MAX_CHANGES_PER_DAY, which also keeps anyone from
// walking their own location around to triangulate someone else.
//
// Writes userLocations/{uid}, the owner's summary in private/account, and
// the public city label on users/{uid} (only if the profile exists —
// onboarding creates it, and initUserDefaults copies the label over then).
export const setLocation = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ changed: boolean; label: string | null; marketCityId: string | null }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    await requireActive(request.auth.uid)
    const uid = request.auth.uid
    const data = (request.data ?? {}) as Record<string, unknown>
    const lat = snap(coord(data.lat, 90))
    const lng = snap(coord(data.lng, 180))
    await takeRateLimit(uid, 'setLocation', { max: SET_LOCATION_PER_HOUR, windowMs: 60 * 60 * 1000 })

    const existing = (await locationRef(uid).get()).data()
    const account = (await accountRef(uid).get()).data()
    const savedLabel: unknown = account?.location?.label
    // F-125: the same grid cell changes nothing, label or not (a spot with no
    // city name used to go back to the geocoder on every call).
    if (existing?.lat === lat && existing?.lng === lng) {
      return {
        changed: false,
        label: typeof savedLabel === 'string' ? savedLabel : null,
        marketCityId: typeof existing.marketCityId === 'string' ? existing.marketCityId : null,
      }
    }

    const now = Date.now()
    const recent = (Array.isArray(existing?.changes) ? (existing.changes as unknown[]) : []).filter(
      (t): t is number => typeof t === 'number' && now - t < DAY_MS,
    )
    const moved = existing?.lat !== lat || existing?.lng !== lng
    if (moved && recent.length >= MAX_CHANGES_PER_DAY) throw new HttpsError('resource-exhausted', LOCATION_LIMIT_MESSAGE)

    const label = (await reverseGeocode(lat, lng)) ?? (typeof savedLabel === 'string' ? savedLabel : null)
    // Austin-only launch (Matthew, 2026-10-09): the market is where you are
    // now — the deck is always the people near you. (F-114's first-save lock
    // is gone: pre-launch Elite and founder claims now need a Founding city
    // where you are, cityStatus.ts, and moves stay limited — above.)
    const marketCityId = getNearestCity(lat, lng)?.id ?? null
    // Stage C (decision 1): outside every launch radius, linked to the
    // nearest launch or major city.
    const linkedCityId = marketCityId ? null : getLinkedCity(lat, lng).id
    const updatedAt = Timestamp.now()

    await locationRef(uid).set({
      lat,
      lng,
      marketCityId,
      ...(linkedCityId ? { linkedCityId } : {}),
      updatedAt,
      changes: moved ? [...recent, now] : recent,
    })
    await accountRef(uid).set({ location: { lat, lng, label, marketCityId, updatedAt } }, { merge: true })
    const root = userRef(uid)
    if ((await root.get()).exists) {
      await root.update({
        ...(label && { locationLabel: label }),
        // Older copies of the coordinates on the public doc go.
        locationLat: FieldValue.delete(),
        locationLng: FieldValue.delete(),
        locationUpdatedAt: FieldValue.delete(),
        geohash: FieldValue.delete(),
        _location: FieldValue.delete(),
      })
    }
    logger.info('setLocation', { moved, marketCityId, changesToday: moved ? recent.length + 1 : recent.length })
    return { changed: moved, label, marketCityId }
  },
)

// ─── getDistances ────────────────────────────────────────────────────────────

const MAX_UIDS = 200
const CALL_WINDOW_MS = 10 * 60 * 1000
const MAX_CALLS_PER_WINDOW = 120
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/

// Distances as coarse labels (Stage 3, with the finer grid): 0 = under a
// mile, whole miles to 10, then 5-mile steps to 50, then 51 = "50+".
export function bucketMiles(miles: number): number {
  if (miles < 1) return 0
  if (miles <= 10) return Math.max(1, Math.round(miles))
  if (miles <= 50) return Math.min(50, Math.ceil(miles / 5) * 5)
  return 51
}

export interface Distance {
  // Coarse miles between the two snapped locations (bucketMiles).
  miles: number
  // Both in the same launch market.
  sameMarket: boolean
}

// Coordinates for a uid: userLocations, else the old copy on the root doc
// (accounts not migrated; bots, which are seeded there).
function coordsFrom(loc: DocumentData | undefined, root: DocumentData | undefined): { lat: number; lng: number; marketCityId: string | null } | null {
  if (typeof loc?.lat === 'number' && typeof loc?.lng === 'number') {
    return { lat: loc.lat, lng: loc.lng, marketCityId: typeof loc.marketCityId === 'string' ? loc.marketCityId : null }
  }
  if (typeof root?.locationLat === 'number' && typeof root?.locationLng === 'number') {
    return { lat: root.locationLat, lng: root.locationLng, marketCityId: null }
  }
  return null
}

// How far the caller is from each of `uids` (up to MAX_UIDS). Anyone without
// a saved location — or the caller, if they have none — is left out.
// Of `uids`, those `uid` may get a distance for (getDistances) — in `mode`
// only (F-065): people from the caller's Spark deck, matches and likes for a
// Spark call, from Play's for a Play call, so neither vouches for the other.
// F-117/F-118: the current deck, live matches, and likers for paid plans
// only; hidden or paused profiles only to a live match (distanceCore.ts).
async function visibleTo(uid: string, uids: string[], mode: 'spark' | 'play'): Promise<Set<string>> {
  const db = getFirestore()
  const [state, matches, queue, plan] = await Promise.all([
    db.doc(`exploreState/${uid}`).get(),
    mode === 'spark'
      ? db.collection('matches').where('users', 'array-contains', uid).get()
      : // F-062: Play matches' people are in their server-only records.
        db.collection('playMatchMembers').where('users', 'array-contains', uid).get(),
    db.collection(`users/${uid}/likeQueue`).select().get(),
    tierNow(uid),
  ])
  const st = state.data() ?? {}
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  // Play likes are keyed by the liker's Play ID; Spark likes by uid.
  const likers = new Set(
    (await Promise.all(
      queue.docs.filter((d) => isPlayId(d.id) === (mode === 'play')).map(async (d) => (isPlayId(d.id) ? await uidOfPlayId(d.id) : d.id)),
    )).filter((u): u is string => !!u),
  )
  // Play: playMatchMembers names the match; whether it's live is on the match.
  const liveMatched = new Set<string>()
  if (mode === 'spark') {
    for (const d of matches.docs) if (matchIsLive(d.data())) for (const u of list(d.get('users'))) liveMatched.add(u)
  } else if (matches.docs.length) {
    const live = await db.getAll(...matches.docs.map((d) => db.doc(`playMatches/${d.id}`)))
    matches.docs.forEach((d, i) => {
      if (live[i].exists && matchIsLive(live[i].data() ?? {})) for (const u of list(d.get('users'))) liveMatched.add(u)
    })
  }
  const deck = new Set(list(st[mode]?.deck))
  // H3: blocks placed on the caller, and theirs in this mode only.
  const blocked = new Set(hiddenInMode(st, mode))
  const candidates = uids.filter((u) => !blocked.has(u) && (deck.has(u) || liveMatched.has(u) || likers.has(u)))
  if (!candidates.length) return new Set()
  const [internals, roots, plays] = await Promise.all([
    db.getAll(...candidates.map((u) => db.doc(`userInternal/${u}`))),
    db.getAll(...candidates.map(userRef)),
    mode === 'play' ? db.getAll(...candidates.map((u) => db.doc(`users/${u}/playProfile/data`))) : Promise.resolve(null),
  ])
  const callerPaid = plan !== 'free'
  return new Set(
    candidates.filter((u, i) => {
      if (internals[i].get('isSuspended') === true || roots[i].get('isDeleted') === true || !roots[i].exists) return false
      const visibility = mode === 'play' ? plays?.[i]?.get('playVisibility') : roots[i].get('sparkVisibility')
      return distanceAllowed(
        { inDeck: deck.has(u), liveMatch: liveMatched.has(u), liker: likers.has(u) },
        { callerPaid, targetHidden: isHiddenVisibility(visibility) },
      )
    }),
  )
}

export const getDistances = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ distances: Record<string, Distance> }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    await requireActive(request.auth.uid)
    const uid = request.auth.uid
    const raw = (request.data as Record<string, unknown> | null)?.uids
    if (!Array.isArray(raw) || raw.length > MAX_UIDS || !raw.every((u) => typeof u === 'string' && UID_RE.test(u))) {
      throw new HttpsError('invalid-argument', `uids must be up to ${MAX_UIDS} user ids`)
    }
    // F-062: in Play, people are named by Play ID — answered by the same ID.
    // F-065: one namespace per call. Mixed, a uid and a Play ID of the same
    // person collapsed into one answer, which said they were the same.
    const asked = [...new Set(raw as string[])]
    const play = asked.some(isPlayId)
    if (play && !asked.every(isPlayId)) throw new HttpsError('invalid-argument', 'uids and Play IDs go in separate calls')
    const owners = await Promise.all(asked.map(async (x) => (isPlayId(x) ? await uidOfPlayId(x) : x)))
    const idFor = new Map<string, string>()
    asked.forEach((x, i) => owners[i] && idFor.set(owners[i]!, x))
    const uids = [...idFor.keys()].filter((u) => u !== uid)
    await takeRateLimit(uid, 'distances', { max: MAX_CALLS_PER_WINDOW, windowMs: CALL_WINDOW_MS })
    const db = getFirestore()

    const [myLoc, myRoot] = await Promise.all([locationRef(uid).get(), userRef(uid).get()])
    const me = coordsFrom(myLoc.data(), myRoot.data())
    if (!me || uids.length === 0) return { distances: {} }
    const myMarket = marketFor(me)
    // Stage B (F-055): only people the caller has a reason to see — in their
    // Explore deck or already seen there, matched, or who liked them — and
    // not blocked either way, suspended or deleted. Any uid used to work, so
    // a blocked person could narrow down someone's ~1-mile cell by moving.
    const visible = await visibleTo(uid, uids, play ? 'play' : 'spark')

    const locs = await db.getAll(...uids.map(locationRef))
    const missing = uids.filter((_, i) => typeof locs[i].data()?.lat !== 'number')
    const roots = missing.length ? await db.getAll(...missing.map(userRef)) : []
    const rootOf = new Map(roots.map((s) => [s.id, s.data()]))

    const distances: Record<string, Distance> = {}
    uids.forEach((u, i) => {
      if (!visible.has(u)) return
      const them = coordsFrom(locs[i].data(), rootOf.get(u))
      if (!them) return
      const miles = distanceMiles(me.lat, me.lng, them.lat, them.lng)
      distances[idFor.get(u) ?? u] = {
        miles: bucketMiles(miles),
        sameMarket: !!myMarket && marketFor(them)?.id === myMarket.id,
      }
    })
    return { distances }
  },
)

// ─── grantSmsConsent ─────────────────────────────────────────────────────────

// Turns on texts: records consent with the phone number from the caller's
// verified sign-in (never one the client sends), where it was given and the
// exact wording shown (by version; the text comes from SMS_CONSENT_TEXTS, not
// the client), in private/account. A new opt-in lifts an earlier STOP on our
// side, then the confirmation text goes out. If the carrier still has the
// number blocked from a STOP, it comes back opted_out with our number, and
// the person texts START to it.
export const grantSmsConsent = onCall(
  { timeoutSeconds: 20, memory: '256MiB', invoker: 'public', secrets: SMS_SECRETS },
  async (request): Promise<{ ok: true; confirmation: Delivery | 'none'; from: string | null }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const phone: unknown = request.auth.token.phone_number
    if (typeof phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(phone)) {
      throw new HttpsError('failed-precondition', 'Sign in with a phone number to turn on texts.')
    }
    const data = (request.data ?? {}) as Record<string, unknown>
    // Clients from before versioned consent send nothing: the old pop-up.
    const textVersion = data.textVersion === undefined ? 'legacy' : data.textVersion
    if (typeof textVersion !== 'string' || !(textVersion in SMS_CONSENT_TEXTS)) {
      throw new HttpsError('invalid-argument', 'Unknown consent text version.')
    }
    const source = data.source === undefined ? 'unknown' : data.source
    if (source !== 'unknown' && !SMS_CONSENT_SOURCES.includes(source as SmsConsentSource)) {
      throw new HttpsError('invalid-argument', 'Unknown consent source.')
    }
    // Each call sends a confirmation text.
    await takeRateLimit(uid, 'smsConsent', { max: 5, windowMs: 60 * 60 * 1000 })

    await accountRef(uid).set(
      {
        smsConsent: { grantedAt: FieldValue.serverTimestamp(), phone, source, textVersion, text: SMS_CONSENT_TEXTS[textVersion] },
        smsOptOut: FieldValue.delete(),
      },
      { merge: true },
    )
    await optOutRef(phone).delete()
    // The waitlist's opt-in: no confirmation text (the screen confirms it;
    // Matthew, 2026-10-09) — its one text is the activation notice.
    if (source === 'waitlist') return { ok: true, confirmation: 'none', from: null }
    // F-122: one confirmation text a day per number — opting in again (up to
    // 5 an hour) used to text each time. Within the day it was already sent.
    const lastConfirmed: unknown = (await accountRef(uid).get()).data()?.smsConsentConfirmed
    const recent =
      typeof lastConfirmed === 'object' && lastConfirmed !== null &&
      (lastConfirmed as Record<string, unknown>).phone === phone &&
      Date.now() - Number((lastConfirmed as Record<string, unknown>).at) < DAY_MS
    if (recent) return { ok: true, confirmation: 'sent', from: null }
    const confirmation = await sendConsentConfirmation(phone)
    if (confirmation === 'sent') await accountRef(uid).set({ smsConsentConfirmed: { phone, at: Date.now() } }, { merge: true })
    return { ok: true, confirmation, from: confirmation === 'opted_out' ? smsFromNumber() : null }
  },
)

// ─── recordActivity ──────────────────────────────────────────────────────────

// When the user was last in the app (admin activity stats), server-side.
// At most one write an hour.
export const recordActivity = onCall(
  { timeoutSeconds: 20, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ ok: true }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    // F-096: a deleted account's sign-in can outlive it by up to an hour —
    // no server record is made for it again (nor for one with no profile yet;
    // the activity stats only list profiles).
    if (await isDeletedUid(request.auth.uid)) return { ok: true }
    const ref = internalRef(request.auth.uid)
    const last: unknown = (await ref.get()).data()?.lastActive
    const now = Date.now()
    if (typeof last !== 'number' || now - last >= 60 * 60 * 1000) await ref.set({ lastActive: now }, { merge: true })
    return { ok: true }
  },
)

// ─── refreshAges ─────────────────────────────────────────────────────────────

// Whole years from an ISO birthday ("1995-04-12"), or null.
export function ageFrom(birthday: unknown, now = new Date()): number | null {
  if (typeof birthday !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthday)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  let age = now.getUTCFullYear() - y
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) age--
  return age >= 0 && age < 130 ? age : null
}

// 4am Central: the public age follows the private birthday (birthdays only
// live in private/identity now, so nothing else ages people).
export const refreshAges = onSchedule(
  { schedule: '0 4 * * *', timeZone: 'America/Chicago', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db = getFirestore()
    const users = await db.collection('users').select('age', 'isDeleted').get()
    const live = users.docs.filter((d) => d.data().isDeleted !== true)
    let updated = 0
    for (let i = 0; i < live.length; i += 100) {
      const chunk = live.slice(i, i + 100)
      const identities = await db.getAll(...chunk.map((d) => identityRef(d.id)))
      for (const [j, idDoc] of identities.entries()) {
        const age = ageFrom(idDoc.data()?.birthday)
        if (age === null || chunk[j].data().age === age) continue
        await chunk[j].ref.update({ age })
        updated++
      }
    }
    logger.info('refreshAges', { users: live.length, updated })
  },
)
