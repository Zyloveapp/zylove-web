import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { distanceMiles } from './cities'
import { marketFor } from './trial'
import { isBotUid, playStatus, requirePlayAccess } from './playAccess'
import { isSuspendedUid, loadInternal, loadLocation, loadMatching, loadPrivateProfile, userRef } from './userData'
import { takeRateLimit, takeRateLimitUpTo } from './rateLimits'
import { signPhotoRefs } from './photoAccess'
import { recordCapHit } from './trustSignals'
import { bucketMiles } from './location'

// Server-side Explore (Stage 3). Clients can no longer list users/{uid}
// (rules); the deck comes from here, filtered exactly as the app's Explore
// did:
//
//   exploreIndex/{uid}   one compact entry per discoverable person, kept by
//                        triggers (server-only): which modes are active, who
//                        they are and want, age and age range, distance
//                        setting, snapped location, market, sort key, bot
//   exploreState/{uid}   per mode: people already acted on (liked/passed,
//                        most recent 5,000) and the current deck; blocks
//
// Anti-scraping: a deck only advances as the user swipes. A call returns the
// same unseen cards until they're acted on; new people only fill the places
// of the ones swiped. On top: a burst limit, a daily cap on calls and a
// daily cap on new people revealed.

// T&S Phase 1: share of reduced-visibility profiles left out of a deck refill.
const REDUCED_SKIP = 0.8
const DECK_SIZE = 20
const SCAN = 60
const MAX_ACTED = 5000
const LOCAL_MILES = 50
const DEFAULT_RADIUS_MILES = 25
export const MAX_RADIUS_MILES = 100
export const DAILY_DECK_CALLS = 150
export const DAILY_NEW_PROFILES = 500
const DAY_MS = 24 * 60 * 60 * 1000

type Mode = 'spark' | 'play'
const db = () => getFirestore()
export const indexRef = (uid: string) => db().doc(`exploreIndex/${uid}`)
export const stateRef = (uid: string) => db().doc(`exploreState/${uid}`)

// Mirrors the web app's genderToAttractedToCategory (src/utils/genderUtils.ts).
function categoriesOf(genderIdentity: unknown, matchableAs: unknown): string[] {
  const g = Array.isArray(genderIdentity) ? genderIdentity[0] : genderIdentity
  switch (g) {
    case 'man':
    case 'trans_man':
      return ['men']
    case 'woman':
    case 'trans_woman':
      return ['women']
    case 'nonbinary':
      return ['nonbinary_people']
    default:
      return Array.isArray(matchableAs) && matchableAs.length ? matchableAs.filter((x): x is string => typeof x === 'string') : ['everyone']
  }
}
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [])
const hidden = (v: unknown) => v === 'paused' || v === 'hidden'
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// ─── Index ───────────────────────────────────────────────────────────────────

export async function buildEntry(uid: string): Promise<DocumentData | null> {
  const root = (await userRef(uid).get()).data()
  if (!root || root.isDeleted === true) return null
  const bot = isBotUid(uid)
  const [internal, matching, loc, meta, playSnap, access] = await Promise.all([
    loadInternal(uid, root),
    loadMatching(uid, root),
    loadLocation(uid, root),
    loadPrivateProfile(uid, root),
    db().doc(`users/${uid}/playProfile/data`).get(),
    playStatus(uid),
  ])
  if (!bot && (internal.isSuspended === true || root.isSuspended === true)) return null
  const play = playSnap.data()
  const sparkActive =
    (bot || root.onboardingComplete === true) &&
    !hidden(root.sparkVisibility) &&
    list(root.photoURLs).length > 0 &&
    meta.intent !== 'play'
  const playActive = access.access && !!play && !hidden(play.playVisibility) && list(play.photoURLs).length > 0
  if (!sparkActive && !playActive) return null
  const radius = matching.radiusMiles === null ? null : num(matching.radiusMiles)
  return {
    uid,
    bot,
    sortKey: num(root.sortKey) ?? Math.random(),
    sparkActive,
    playActive,
    cats: categoriesOf(root.genderIdentity, matching.matchableAs),
    attractedTo: list(matching.attractedTo),
    age: num(root.age),
    ageMin: num(matching.ageMin),
    ageMax: num(matching.ageMax),
    // undefined: the default; null: no limit
    radiusMiles: matching.radiusMiles === undefined ? DEFAULT_RADIUS_MILES : radius,
    lat: loc?.lat ?? null,
    lng: loc?.lng ?? null,
    marketCityId: loc ? (marketFor(loc)?.id ?? null) : null,
    label: typeof root.locationLabel === 'string' ? root.locationLabel : '',
    // T&S Phase 1: an admin reduced this account's visibility (trust review).
    reduced: internal.visibilityReduced === true,
  }
}

export async function refreshEntry(uid: string): Promise<void> {
  const entry = await buildEntry(uid)
  if (entry) await indexRef(uid).set(entry)
  else await indexRef(uid).delete()
}

const refreshQuietly = (uid: string) =>
  refreshEntry(uid).catch((err) => logger.error('explore index refresh failed', { message: String(err) }))

export const exploreOnUser = onDocumentWritten({ document: 'users/{uid}' }, async (e) => refreshQuietly(e.params.uid))
export const exploreOnUserDoc = onDocumentWritten({ document: 'users/{uid}/{sub}/{doc}' }, async (e) => {
  const { sub, doc } = e.params
  if ((sub === 'playProfile' && doc === 'data') || (sub === 'private' && (doc === 'matching' || doc === 'profile'))) {
    await refreshQuietly(e.params.uid)
  }
})
export const exploreOnLocation = onDocumentWritten({ document: 'userLocations/{uid}' }, async (e) => refreshQuietly(e.params.uid))
export const exploreOnInternal = onDocumentWritten({ document: 'userInternal/{uid}' }, async (e) => {
  const b = e.data?.before.data(), a = e.data?.after.data()
  const keys = ['isSuspended', 'playAccess', 'playAccessUntil']
  if (keys.some((k) => JSON.stringify(b?.[k] ?? null) !== JSON.stringify(a?.[k] ?? null))) await refreshQuietly(e.params.uid)
})

// ─── State ───────────────────────────────────────────────────────────────────

// Someone acted on in a mode (liked, passed, matched): never shown again,
// and out of the deck. Called by recordSwipe / onLike / likeBack.
export async function markActed(uid: string, mode: Mode, target: string): Promise<void> {
  const ref = stateRef(uid)
  await db().runTransaction(async (tx) => {
    const s = (await tx.get(ref)).data() ?? {}
    const m = s[mode] ?? {}
    const acted = list(m.acted).filter((u) => u !== target)
    acted.push(target)
    tx.set(ref, { [mode]: { acted: acted.slice(-MAX_ACTED), deck: list(m.deck).filter((u) => u !== target) } }, { merge: true })
  })
}

export async function setBlocked(a: string, b: string, blocked: boolean): Promise<void> {
  const { FieldValue } = await import('firebase-admin/firestore')
  const op = blocked ? FieldValue.arrayUnion : FieldValue.arrayRemove
  await Promise.all([
    stateRef(a).set({ blocked: op(b) }, { merge: true }),
    stateRef(b).set({ blocked: op(a) }, { merge: true }),
  ])
}

// ─── Deck ────────────────────────────────────────────────────────────────────

interface Card {
  uid: string
  profile: DocumentData
  playProfile?: DocumentData
  distanceMiles: number | null
  sameMarket: boolean
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function mutuallyAttracted(me: DocumentData, them: DocumentData): boolean {
  const theyWantMe = list(them.attractedTo)
  const iWantThem = list(me.attractedTo)
  return (
    (theyWantMe.includes('everyone') || theyWantMe.some((a) => list(me.cats).includes(a))) &&
    (iWantThem.includes('everyone') || iWantThem.some((a) => list(them.cats).includes(a)))
  )
}

function milesBetween(a: DocumentData, b: DocumentData): number | null {
  return num(a.lat) !== null && num(a.lng) !== null && num(b.lat) !== null && num(b.lng) !== null
    ? distanceMiles(a.lat, a.lng, b.lat, b.lng)
    : null
}

// T&S Phase 2: "Member since" and the reply band show on Play cards too.
const PLAY_CARD_FIELDS = ['age', 'genderIdentity', 'pronouns', 'locationLabel', 'verificationStatus', 'isFounder', 'founderBadge', 'founderCity', 'zyloveScoreTier', 'heightCm', 'memberSince', 'replyBand']
function pickPlayCardFields(profile: DocumentData): DocumentData {
  return Object.fromEntries(PLAY_CARD_FIELDS.filter((f) => profile[f] !== undefined).map((f) => [f, profile[f]]))
}

// The same rules the app's Explore applied (discover.ts isEligible / withinRadius).
function eligible(me: DocumentData, c: DocumentData, mode: Mode, founding: boolean): boolean {
  if (c.uid === me.uid) return false
  if (!(mode === 'play' ? c.playActive : c.sparkActive)) return false
  if (c.age !== null && me.ageMin && me.ageMax && (c.age < me.ageMin || c.age > me.ageMax)) return false
  // Stage C (decision 1): real people are always within the viewer's own
  // distance, at most 100 miles (an old "no limit" counts as 100); bots
  // show at any distance, and only while the city is founding.
  if (c.bot) {
    if (!founding) return false
  } else {
    const radius = Math.min(me.radiusMiles === null ? MAX_RADIUS_MILES : me.radiusMiles || DEFAULT_RADIUS_MILES, MAX_RADIUS_MILES)
    const miles = milesBetween(me, c)
    if (miles !== null && miles > radius) return false
  }
  return mutuallyAttracted(me, c)
}

function isLocal(me: DocumentData, c: DocumentData): boolean {
  if (me.marketCityId) {
    if (c.marketCityId) return c.marketCityId === me.marketCityId
    const city = String(c.label ?? '').split(',')[0]?.trim().toLowerCase()
    return !!city && city === String(me.marketName ?? '').toLowerCase()
  }
  const miles = milesBetween(me, c)
  return miles !== null && miles <= LOCAL_MILES
}

export const getExploreDeck = onCall(
  { timeoutSeconds: 30, invoker: 'public' },
  async (request): Promise<{ cards: Card[]; photoUrls: Record<string, string>; expiresAt: number; exhausted: boolean }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const mode: Mode = (request.data as Record<string, unknown> | null)?.mode === 'play' ? 'play' : 'spark'
    if (mode === 'play') await requirePlayAccess(uid)
    await takeRateLimit(uid, 'exploreBurst', { max: 30, windowMs: 10 * 60 * 1000 })
    await takeRateLimit(uid, 'exploreDay', { max: DAILY_DECK_CALLS, windowMs: DAY_MS }).catch(async (err: unknown) => {
      await recordCapHit(uid) // T&S Phase 1: a deck cap hit is a behaviour signal
      throw err
    })

    const root = (await userRef(uid).get()).data()
    if (!root || (await isSuspendedUid(uid, root))) throw new HttpsError('failed-precondition', 'Profile not available')
    const [stateSnap, matchSnap] = await Promise.all([
      stateRef(uid).get(),
      db().collection('matches').where('users', 'array-contains', uid).where('mode', '==', mode).get(),
    ])
    const loc = await loadLocation(uid, root)
    const myMarket = loc ? marketFor(loc) : null
    // Your own preferences even when you're not discoverable yourself.
    const matching = await loadMatching(uid, root)
    const me: DocumentData = {
      uid,
      cats: categoriesOf(root.genderIdentity, matching.matchableAs),
      attractedTo: list(matching.attractedTo),
      ageMin: num(matching.ageMin),
      ageMax: num(matching.ageMax),
      radiusMiles: matching.radiusMiles === undefined ? DEFAULT_RADIUS_MILES : matching.radiusMiles === null ? null : num(matching.radiusMiles),
      lat: loc?.lat ?? null,
      lng: loc?.lng ?? null,
      marketCityId: myMarket?.id ?? null,
      marketName: myMarket?.name ?? null,
    }
    // Founding period (as the app's inFoundingPeriod): no launch city, or its
    // founding circle hasn't filled (bots still on) — everyone, any distance,
    // bots included.
    const founding = myMarket ? (await db().doc(`config/city_${myMarket.id}`).get()).data()?.botsActive !== false : true

    const state = stateSnap.data() ?? {}
    const m = state[mode] ?? {}
    const excluded = new Set<string>([uid, ...list(m.acted), ...list(state.blocked)])
    for (const d of matchSnap.docs) for (const u of list(d.get('users'))) excluded.add(u)

    // The current deck, minus anyone acted on or no longer there.
    const kept = list(m.deck).filter((u) => !excluded.has(u))
    const keptEntries = kept.length ? await db().getAll(...kept.map(indexRef)) : []
    const deck = keptEntries.filter((s) => s.exists && eligible(me, { ...s.data(), uid: s.id }, mode, founding)).map((s) => ({ ...s.data(), uid: s.id }) as DocumentData)

    // Fill the places of the ones swiped — and no more than today's cap of new people.
    let need = DECK_SIZE - deck.length
    let exhausted = false
    if (need > 0) {
      const inDeck = new Set(deck.map((d) => d.uid))
      const found: DocumentData[] = []
      const field = mode === 'play' ? 'playActive' : 'sparkActive'
      const passes = [
        db().collection('exploreIndex').where(field, '==', true).orderBy('sortKey').startAfter(Math.random()).limit(SCAN),
        db().collection('exploreIndex').where(field, '==', true).orderBy('sortKey').limit(SCAN),
      ]
      for (const q of passes) {
        if (found.length >= need) break
        for (const d of (await q.get()).docs) {
          const c = { ...d.data(), uid: d.id }
          if (excluded.has(c.uid) || inDeck.has(c.uid) || found.some((f) => f.uid === c.uid)) continue
          // Reduced visibility (trust review): usually skipped, never first.
          if ((c as DocumentData).reduced === true && Math.random() < REDUCED_SKIP) continue
          if (eligible(me, c, mode, founding)) found.push(c)
        }
      }
      // Today's cap on new people (counted as they're revealed).
      const allowed = await takeRateLimitUpTo(uid, 'exploreNew', Math.min(need, found.length), { max: DAILY_NEW_PROFILES, windowMs: DAY_MS })
      if (allowed < Math.min(need, found.length)) await recordCapHit(uid)
      exhausted = found.length < need
      // Local first, then bots, then everyone else — each shuffled.
      const fresh = found.slice(0, allowed)
      const real = fresh.filter((c) => !c.bot)
      const local = real.filter((c) => isLocal(me, c))
      const ordered = [...shuffle(local), ...shuffle(fresh.filter((c) => c.bot)), ...shuffle(real.filter((c) => !local.includes(c)))]
        .sort((a, b) => Number(a.reduced === true) - Number(b.reduced === true))
      deck.push(...ordered)
      need = DECK_SIZE - deck.length
    }
    await stateRef(uid).set({ [mode]: { deck: deck.map((d) => d.uid) } }, { merge: true })

    // Cards: the public profile (and, in Play, the Play profile), a coarse distance, signed photos.
    const uids = deck.map((d) => d.uid)
    const [roots, plays, internals] = await Promise.all([
      uids.length ? db().getAll(...uids.map((u) => userRef(u))) : Promise.resolve([]),
      mode === 'play' && uids.length ? db().getAll(...uids.map((u) => db().doc(`users/${u}/playProfile/data`))) : Promise.resolve([]),
      // Stage B (F-055): suspension re-checked as the cards go out, not
      // trusted from the index (a missed refresh would have shown them).
      uids.length ? db().getAll(...uids.map((u) => db().doc(`userInternal/${u}`))) : Promise.resolve([]),
    ])
    const cards: Card[] = []
    const refs: string[] = []
    deck.forEach((d, i) => {
      const profile = roots[i]?.data()
      if (!profile || profile.isDeleted === true || (!isBotUid(d.uid) && internals[i]?.get('isSuspended') === true)) return
      const playProfile = mode === 'play' ? plays[i]?.data() : undefined
      const miles = milesBetween(me, d)
      cards.push({
        uid: d.uid,
        // Stage C (Play pseudonymity, display level): a Play card carries
        // only what Play shows from the public profile — never the Spark
        // name, photos, bio or prompts.
        profile: mode === 'play' ? pickPlayCardFields(profile) : profile,
        ...(playProfile ? { playProfile } : {}),
        distanceMiles: miles === null ? null : bucketMiles(miles),
        sameMarket: !!me.marketCityId && d.marketCityId === me.marketCityId,
      })
      refs.push(...list(mode === 'play' ? playProfile?.photoURLs : profile.photoURLs).filter((r) => r.startsWith('photos/')))
    })
    const { urls, expiresAt } = await signPhotoRefs(refs)
    return { cards, photoUrls: urls, expiresAt, exhausted }
  },
)

