// City founding circles: members within 50 miles of a launch city
// (cities.ts) get a permanent "<City> Founder" badge and Elite, assigned
// automatically at the end of onboarding, until that city's half (women or
// men) is full. When both halves fill, the city's bots go off for viewers in
// that city (discover.ts reads config/city_{id}.botsActive).
//
// config/city_{id} (server-only) holds each city's counters: womenCount,
// menCount against founderTarget (per half). publicStats/city_{id} is the
// public copy (members / capacity). Flat ids: config and publicStats are
// one-level collections in the rules.
//
// Founders must stay active during launch (founderActivity.ts). The
// lifecycle lives in founderRecords/{uid}, which only Cloud Functions can
// read or write (rules default-deny); the users/{uid} copies (founderStatus,
// founderLastActiveAt, …) are display mirrors, since clients can edit
// those fields on their own doc.
//
// Austin also keeps config/launch and publicStats/founding up to date: they
// are shared with the mobile founder-code program (redeemFounderCode) and
// the landing page. Filling Austin no longer sets config/launch.botsActive,
// because that hides every bot everywhere (onLaunchConfigUpdated).

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { FieldPath, FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { ZYLOVE_CITIES, getNearestCity } from './cities'
import { LOOKUP_SECRETS, lookupLineType, textAccount } from './sms'
import { foundingPeriod } from './cityStatus'
import { founderGate, founderPhoneHash, type GateRefusal } from './founderGate'
import { takeRateLimit } from './rateLimits'
import { getAuth } from 'firebase-admin/auth'
import { accountRef, internalRef, loadLocation, requireActive } from './userData'
import { eliteByMatching } from './identity'

// Per half (women / men); a city's circle is twice this.
export const DEFAULT_FOUNDER_TARGET = 50
// Everyone else counts toward the other half.
const BOT_PREFIX = 'zbot-'

type Ineligible = 'outside_coverage' | 'already_assigned' | 'cohort_full' | 'no_profile' | 'not_founding' | 'head_start' | GateRefusal
export type FounderResult =
  | { eligible: true; cohortNumber: number; cityId: string; cityName: string }
  | { eligible: false; reason: Ineligible }
// The transaction also says whether this claim was the one that filled the city.
type Claim = FounderResult & { closedCity?: boolean }


export type Bucket = 'women' | 'men'

// Lifecycle (founderRecords/{uid}.status). Spot holders count toward the
// city's womenCount/menCount; only active and permanent founders count as
// members on the public counter.
export type FounderStatus = 'active' | 'pending_revocation' | 'permanent' | 'revoked' | 'converted'
const MEMBER_STATUSES = new Set(['active', 'permanent'])

// Spark profiles store a string, Play an array; the first entry decides.
// Stage C (decision 2): the women's half is for people matched as women or
// nonbinary people (identity.ts) — not anyone who isn't a man by identity.
export function bucketFor(genderIdentity: unknown, matchableAs?: unknown): Bucket {
  return eliteByMatching(genderIdentity, matchableAs) ? 'women' : 'men'
}

export const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)

// Texts about the founder's own spot (at risk, expiring, converted): either
// mode's SMS switch will do (smsTarget also checks consent, opt-out, quiet
// hours and that there's a number).
export async function textFounder(uid: string, body: string): Promise<boolean> {
  return textAccount(uid, 'founder', body)
}

// Location is self-reported (browser geolocation via setLocation, snapped to
// ~3 miles), so this is a launch-period gate, not proof of residence. It's the
// stored location (userLocations), never coordinates sent with the call.
export const assignFounderBadge = onCall(
  { timeoutSeconds: 60, memory: '256MiB', invoker: 'public', secrets: LOOKUP_SECRETS },
  async (request): Promise<FounderResult> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    await requireActive(request.auth.uid) // F-097: not while suspended
    // F-115: each attempt can cost a Lookup.
    await takeRateLimit(request.auth.uid, 'founderClaim', { max: 5, windowMs: 24 * 60 * 60 * 1000 })
    const loc = await loadLocation(request.auth.uid)
    if (!loc) return { eligible: false, reason: 'outside_coverage' }
    // F-115: the sign-in number's line type (null: unknown — let through).
    const phone = typeof request.auth.token.phone_number === 'string' ? request.auth.token.phone_number : null
    const lineType = phone ? await lookupLineType(phone, 6000) : null
    return claimFounderSpot(request.auth.uid, loc.lat, loc.lng, 'assignFounderBadge', { gate: true, lineType })
  },
)

// The founder claim itself: the city at (lat, lng), its half's counter, the
// user's founder fields and lifecycle record. Shared by the user's own
// claim and the admin dashboard's "Make founder" (which passes the user's
// saved location).
// opts.gate: the user's own claim — the F-114/F-115/F-116 checks
// (founderGate.ts). The admin dashboard's "Make founder" passes none.
export async function claimFounderSpot(
  uid: string,
  lat: number,
  lng: number,
  source: string,
  opts: { gate?: boolean; lineType?: string | null } = {},
): Promise<FounderResult> {
  const city = getNearestCity(lat, lng)
  if (!city) return { eligible: false, reason: 'outside_coverage' }
  // F-116: one spot per phone number, recorded by its hash.
  const phone = (await getAuth().getUser(uid).catch(() => null))?.phoneNumber ?? null
  const phoneHash = phone ? founderPhoneHash(phone) : null

  const db = getFirestore()
  const cityRef = db.doc(`config/city_${city.id}`)
  const statsRef = db.doc(`publicStats/city_${city.id}`)
  const launchRef = db.doc('config/launch')
  const userRef = db.doc(`users/${uid}`)
  const recordRef = db.doc(`founderRecords/${uid}`)
  const isAustin = city.id === 'austin'

  const historyRef = phoneHash ? db.doc(`founderHistory/${phoneHash}`) : null
  const claim = await db.runTransaction(async (tx): Promise<Claim> => {
    const [citySnap, userSnap, launchSnap, recordSnap, matchingSnap, internalSnap, historySnap] = await Promise.all([
      tx.get(cityRef),
      tx.get(userRef),
      isAustin ? tx.get(launchRef) : Promise.resolve(null),
      tx.get(recordRef),
      tx.get(db.doc(`users/${uid}/private/matching`)),
      tx.get(internalRef(uid)),
      historyRef ? tx.get(historyRef) : Promise.resolve(null),
    ])
    const user = userSnap.data()
    if (!user || user.onboardingComplete !== true) return { eligible: false, reason: 'no_profile' }
    if (user.isFounder === true) return { eligible: false, reason: 'already_assigned' }
    if (opts.gate) {
      const refusal = founderGate({
        accountCreatedAt: internalSnap.get('accountCreatedAt'),
        lineType: opts.lineType ?? null,
        recordStatus: recordSnap.data()?.status,
        history: historySnap?.data(),
        uid,
      })
      if (refusal) return { eligible: false, reason: refusal }
    }
    // Revoked founders may claim again; converted ones (Spark+ for good)
    // already had their turn.
    if (recordSnap.data()?.status === 'converted') return { eligible: false, reason: 'already_assigned' }

    // A missing city doc is created with the defaults (init-cities.mjs
    // normally makes them first).
    const config = citySnap.data() ?? {}
    // Austin-only launch: a spot is claimed only while physically inside a
    // Founding city (the location saved now — setLocation). Not a Locked or
    // Live one. The admin's "Make founder" (no gate) is a deliberate grant.
    if (opts.gate && !foundingPeriod(city.id, citySnap.data())) return { eligible: false, reason: 'not_founding' }
    // UPDATE 3: a city just unlocked from its waitlist — for 72 hours only
    // the first in its founder line may claim there (waitlist.ts). First
    // dibs, not a reservation: the halves below still decide.
    const headStartEnds: unknown = config.founderHeadStartUntil
    if (opts.gate && headStartEnds instanceof Timestamp && headStartEnds.toMillis() > Date.now()) {
      const mine = internalSnap.get('founderHeadStart') as { cityId?: unknown; until?: unknown } | undefined
      const ok = mine?.cityId === city.id && mine?.until instanceof Timestamp && mine.until.toMillis() > Date.now()
      if (!ok) return { eligible: false, reason: 'head_start' }
    }
    const target = num(config.founderTarget, DEFAULT_FOUNDER_TARGET)
    // Austin founder codes (mobile) only count in config/launch, so Austin
    // goes by whichever count is higher; the city doc catches up on write.
    const launch = launchSnap?.data() ?? {}
    const women = Math.max(num(config.womenCount, 0), isAustin ? num(launch.womenCount, 0) : 0)
    const men = Math.max(num(config.menCount, 0), isAustin ? num(launch.menCount, 0) : 0)

    // §4.A2: gender from private/matching (the root's old copy until migrated).
    const bucket = bucketFor(matchingSnap.get('genderIdentity') ?? user.genderIdentity, matchingSnap.get('matchableAs') ?? user.matchableAs)
    if ((bucket === 'women' ? women : men) >= target) return { eligible: false, reason: 'cohort_full' }

    const nextWomen = bucket === 'women' ? women + 1 : women
    const nextMen = bucket === 'men' ? men + 1 : men
    // Member numbers never repeat, even after revocations free spots.
    const cohortNumber = Math.max(num(config.founderSeq, women + men), isAustin ? num(launch.founderCount, 0) : 0) + 1
    const capacity = target * 2
    const fills = nextWomen >= target && nextMen >= target

    tx.set(
      cityRef,
      {
        ...(!citySnap.exists && {
          id: city.id,
          name: city.name,
          state: city.state,
          lat: city.lat,
          lng: city.lng,
          radiusMiles: city.radiusMiles,
          founderTarget: target,
          botsActive: true,
          createdAt: FieldValue.serverTimestamp(),
        }),
        womenCount: nextWomen,
        menCount: nextMen,
        founderSeq: cohortNumber,
        // Both halves full: this city is live, its bots go, and its trials
        // start (trial.ts onMarketOpened).
        ...(fills && { botsActive: false, discoveryOpenedAt: FieldValue.serverTimestamp(), status: 'live' }),
      },
      { merge: true },
    )
    // members is recounted after the transaction (refreshCityMembers).
    tx.set(statsRef, { capacity, cityName: city.name, state: city.state }, { merge: true })
    if (historyRef) tx.set(historyRef, { status: 'active', uid, cityId: city.id, at: FieldValue.serverTimestamp() })
    tx.set(recordRef, {
      uid,
      ...(phoneHash ? { phoneHash } : {}),
      cityId: city.id,
      cityName: city.name,
      bucket,
      status: 'active' satisfies FounderStatus,
      acceptedAt: FieldValue.serverTimestamp(),
      lastActiveAt: FieldValue.serverTimestamp(),
      warningSentAt: null,
      pendingAt: null,
    })
    tx.update(userRef, {
      isFounder: true,
      // Display name, as the mobile app shows it ("Founding Member — Austin").
      founderCohort: city.name,
      founderCity: city.name,
      founderCityId: city.id,
      founderBadge: `${city.badgeName ?? city.name} Founder`,
      founderNumber: cohortNumber,
      founderBadgeAssignedAt: FieldValue.serverTimestamp(),
    })
    // Stage B (F-056): status and activity aren't public — the owner's copy
    // (founderRecords/{uid} is the server's).
    tx.set(accountRef(uid), { founderStatus: 'active' }, { merge: true })

    // Elite, as a founder code gave (plan fields live in userInternal).
    tx.set(internalRef(uid), { subscriptionTier: 'elite' }, { merge: true })

    // Austin's legacy counters (founder codes count here too).
    if (isAustin) {
      tx.set(
        launchRef,
        {
          founderCount: num(launch.founderCount, 0) + 1,
          [`${bucket}Count`]: bucket === 'women' ? nextWomen : nextMen,
          [bucket === 'women' ? 'austinWomenCount' : 'austinMenCount']:
            num(launch[bucket === 'women' ? 'austinWomenCount' : 'austinMenCount'], 0) + 1,
        },
        { merge: true },
      )
    }
    return { eligible: true, cohortNumber, cityId: city.id, cityName: city.name, closedCity: fills && config.botsActive !== false }
  })
  const { closedCity, ...result } = claim
  if (result.eligible) await refreshCityMembers(city.id)
  // City live: shown in the app (LaunchBanner); no texts (SMS is account and
  // match/message notifications only).
  if (closedCity) logger.info('City live', { cityId: city.id })

  logger.info(source, {
    city: city.id,
    result: result.eligible ? `founder #${result.cohortNumber}` : result.reason,
  })
  return result
}

// Recounts publicStats/city_{id}.members from the founders themselves:
// active and permanent only. Founders from before the lifecycle (no status,
// e.g. founder codes) count as active. Austin's count also goes to
// publicStats/founding, which the landing page reads. Never throws.
export async function refreshCityMembers(cityId: string): Promise<void> {
  const city = ZYLOVE_CITIES.find((c) => c.id === cityId)
  if (!city) return
  try {
    const db = getFirestore()
    const users = db.collection('users')
    // Older founders have only founderCohort (the city name).
    const [byId, byName] = await Promise.all([
      users.where('founderCityId', '==', city.id).select('isFounder').get(),
      users.where('founderCohort', '==', city.name).select('isFounder').get(),
    ])
    // Status from founderRecords (Stage B: no longer on the public doc);
    // older founders without a record count.
    const ids = [...new Set([...byId.docs, ...byName.docs].filter((d) => d.get('isFounder') === true).map((d) => d.id))]
    const records = ids.length ? await db.getAll(...ids.map((id) => db.doc(`founderRecords/${id}`))) : []
    let members = 0
    for (const r of records) {
      const status: unknown = r.get('status')
      if (status === undefined || (typeof status === 'string' && MEMBER_STATUSES.has(status))) members++
    }
    const stamp = { members, updatedAt: FieldValue.serverTimestamp() }
    await db.doc(`publicStats/city_${city.id}`).set(stamp, { merge: true })
    if (city.id === 'austin') await db.doc('publicStats/founding').set(stamp, { merge: true })
  } catch (err) {
    logger.error('refreshCityMembers failed', { cityId, message: err instanceof Error ? err.message : String(err) })
  }
}

// config/launch.botsActive true → false (a manual kill switch now): hide
// every bot (zbot-* uid) in both modes, everywhere.
export const onLaunchConfigUpdated = onDocumentUpdated(
  { document: 'config/launch', timeoutSeconds: 300 },
  async (event) => {
    const before = event.data?.before.data()
    const after = event.data?.after.data()
    if (before?.botsActive !== true || after?.botsActive !== false) return

    const db = getFirestore()
    // '.' is the character after '-', so this range is exactly the zbot- ids.
    const bots = await db
      .collection('users')
      .where(FieldPath.documentId(), '>=', BOT_PREFIX)
      .where(FieldPath.documentId(), '<', 'zbot.')
      .get()

    for (let i = 0; i < bots.docs.length; i += 400) {
      const batch = db.batch()
      for (const doc of bots.docs.slice(i, i + 400)) {
        batch.update(doc.ref, { sparkVisibility: 'hidden', playVisibility: FieldValue.delete() })
        // Play visibility lives on the Play profile (Stage 2).
        batch.set(doc.ref.collection('playProfile').doc('data'), { playVisibility: 'hidden' }, { merge: true })
      }
      await batch.commit()
    }
    logger.info('onLaunchConfigUpdated: bots hidden', { count: bots.size })
  },
)
