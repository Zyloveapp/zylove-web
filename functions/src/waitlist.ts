import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { ZYLOVE_CITIES } from './cities'
import {
  CITY_STATUSES,
  admitsSignups,
  admittingCityAt,
  availableCities,
  cityStatus,
  loadCityConfigs,
  nearestLaunchCity,
  foundingPeriod,
  openFlags,
  type CityStatus,
} from './cityStatus'
import { accountRef, clearPrivateData, internalRef, userRef } from './userData'
import { takeRateLimit } from './rateLimits'
import { audit, requireAdmin, requireLiveAdmin } from './audit'
import { SMS_SECRETS, WAITLIST_ACTIVATED_TEXT, loadWaitlistTextConfig, textWaitlister } from './sms'

// Austin-only launch with a city waitlist (Matthew, 2026-10-09).
//
// A new account shares its location before anything else (checkArea):
//   inside a Founding or Live city  → admitted: onboarding as before
//   outside                         → waitlisted for the nearest launch city
//                                     (any distance): no profile docs, no
//                                     deck, no perks, not discoverable
// userInternal/{uid}.admission = { status: 'admitted' | 'waitlisted', cityId,
// at, via } (server-only); the rules let a profile be created only once it's
// 'admitted'. cityWaitlist/{uid} = { cityId, joinedAt, admittedAt, textState }
// (server-only) is the list itself.
//
// Joining needs text consent (grantSmsConsent, source 'waitlist'). Declining
// twice, or leaving, deletes the account and its records (leaveWaitlist).
// When an admin unlocks a city (adminSetCityStatus), everyone waiting for it
// is admitted and sent one plain account notice ("Your account is now
// active…", sms.ts — config/waitlistTexts: on by default, batched, daily cap).
//
// Founder interest (UPDATE 3): a consented waitlister can join the city's
// founder line, founderInterest/{cityId}/requests/{uid} = { uid, at }
// (server-only). When the city unlocks into its founding period, the first
// FOUNDER_LINE (the circle's size) get a 72-hour head start: only they can
// claim a spot there until config/city_{id}.founderHeadStartUntil
// (founders.ts). First dibs, not a reservation — spots stay first-come within
// each half, and every founder rule still applies at claim time.

const db = () => getFirestore()
const waitlistRef = (uid: string) => db().doc(`cityWaitlist/${uid}`)
const CHECK_AREA_PER_HOUR = 10
// Gap between waitlist texts (spread out, well under carrier throughput).
const TEXT_GAP_MS = process.env.FUNCTIONS_EMULATOR === 'true' ? 0 : 2000
const MAX_TEXT_ATTEMPTS = 3
export const HEAD_START_MS = 72 * 60 * 60 * 1000
const DEFAULT_FOUNDER_TARGET = 50 // per half (founders.ts)
const interestRef = (cityId: string, uid: string) => db().doc(`founderInterest/${cityId}/requests/${uid}`)

export type AreaView =
  | { status: 'member' }
  | { status: 'admitted'; cityName: string | null; via: string | null; headStartUntil: number | null }
  | {
      status: 'waitlisted'
      cityId: string
      cityName: string
      available: { name: string; state: string }[]
      consented: boolean
      // Their place in the city's founder line, if they joined it.
      founderLine: number | null
    }
  | { status: 'unknown' }

function coord(v: unknown, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) throw new HttpsError('invalid-argument', 'Invalid location')
  return v
}

const cityName = (id: unknown) => ZYLOVE_CITIES.find((c) => c.id === id)?.name ?? null

// Consented to texts on this number, and not opted out since.
export function hasTextConsent(account: DocumentData | undefined, phone: string | null): boolean {
  const consent = account?.smsConsent
  return !!consent && typeof consent === 'object' && account?.smsOptOut == null && (!phone || consent.phone === phone)
}

async function view(uid: string, admission: DocumentData | undefined, phone: string | null): Promise<AreaView> {
  if (admission?.status === 'admitted') {
    const hs = (await internalRef(uid).get()).get('founderHeadStart') as DocumentData | undefined
    const until = hs?.cityId === admission.cityId && hs?.until instanceof Timestamp ? hs.until.toMillis() : null
    return {
      status: 'admitted',
      cityName: cityName(admission.cityId),
      via: typeof admission.via === 'string' ? admission.via : null,
      headStartUntil: until !== null && until > Date.now() ? until : null,
    }
  }
  if (admission?.status !== 'waitlisted') return { status: 'unknown' }
  const cityId = String(admission.cityId)
  const [configs, account, line] = await Promise.all([loadCityConfigs(), accountRef(uid).get(), founderLinePlace(cityId, uid)])
  return {
    status: 'waitlisted',
    cityId,
    cityName: cityName(cityId) ?? 'your city',
    available: availableCities(configs).map((c) => ({ name: c.name, state: c.state })),
    consented: hasTextConsent(account.data(), phone),
    founderLine: line,
  }
}

// Their place in the city's founder line (1 = first), or null.
export async function founderLinePlace(cityId: string, uid: string): Promise<number | null> {
  const mine = (await interestRef(cityId, uid).get()).get('at')
  if (!(mine instanceof Timestamp)) return null
  const ahead = await db().collection(`founderInterest/${cityId}/requests`).where('at', '<=', mine).count().get()
  return ahead.data().count
}

// ─── checkArea ───────────────────────────────────────────────────────────────

// With { lat, lng }: decides (or re-decides) a new account's admission from
// where it is now. Without: just reports it. A member (onboarded) or an
// account already admitted is never moved back to the waitlist.
export const checkArea = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request): Promise<AreaView> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  const phone = typeof request.auth.token.phone_number === 'string' ? request.auth.token.phone_number : null
  const [root, internal] = await Promise.all([userRef(uid).get(), internalRef(uid).get()])
  if (root.get('onboardingComplete') === true) return { status: 'member' }
  const admission = internal.get('admission') as DocumentData | undefined
  const data = (request.data ?? {}) as Record<string, unknown>
  if (data.lat === undefined && data.lng === undefined) return view(uid, admission, phone)
  const lat = coord(data.lat, 90)
  const lng = coord(data.lng, 180)
  if (admission?.status === 'admitted') return view(uid, admission, phone)
  await takeRateLimit(uid, 'checkArea', { max: CHECK_AREA_PER_HOUR, windowMs: 60 * 60 * 1000 })

  const configs = await loadCityConfigs()
  const city = admittingCityAt(lat, lng, configs)
  const at = Timestamp.now()
  if (city) {
    const next = { status: 'admitted', cityId: city.id, at, via: 'location' }
    await internalRef(uid).set({ admission: next }, { merge: true })
    await waitlistRef(uid).delete()
    logger.info('checkArea', { result: 'admitted', city: city.id })
    return view(uid, next, phone)
  }
  // Waitlisted for the nearest launch city. Only the city is kept, never the
  // coordinates.
  const nearest = nearestLaunchCity(lat, lng)
  const existing = (await waitlistRef(uid).get()).data()
  await waitlistRef(uid).set({
    uid,
    cityId: nearest.id,
    joinedAt: existing?.joinedAt instanceof Timestamp ? existing.joinedAt : at,
    admittedAt: null,
    textState: 'none',
  })
  const next = { status: 'waitlisted', cityId: nearest.id, at, via: 'location' }
  await internalRef(uid).set({ admission: next }, { merge: true })
  logger.info('checkArea', { result: 'waitlisted', city: nearest.id })
  return view(uid, next, phone)
})

// ─── joinFounderLine ─────────────────────────────────────────────────────────

// "I'm interested": a place in the city's founder line. Only for someone on
// the waitlist with text consent (no consent, no waitlist, no line). No gender
// is asked here — the halves are checked when they claim.
export const joinFounderLine = onCall({ timeoutSeconds: 20, memory: '256MiB', invoker: 'public' }, async (request): Promise<{ place: number }> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  const phone = typeof request.auth.token.phone_number === 'string' ? request.auth.token.phone_number : null
  const [internal, account] = await Promise.all([internalRef(uid).get(), accountRef(uid).get()])
  const admission = internal.get('admission') as DocumentData | undefined
  if (admission?.status !== 'waitlisted') throw new HttpsError('failed-precondition', 'Only for people on a city waitlist.')
  if (!hasTextConsent(account.data(), phone)) throw new HttpsError('failed-precondition', 'Turn on texts to stay on the waitlist first.')
  const cityId = String(admission.cityId)
  const ref = interestRef(cityId, uid)
  await db().runTransaction(async (tx) => {
    if (!(await tx.get(ref)).exists) tx.set(ref, { uid, at: FieldValue.serverTimestamp() })
  })
  return { place: (await founderLinePlace(cityId, uid)) ?? 0 }
})

// ─── leaveWaitlist ───────────────────────────────────────────────────────────

// Leaving the waitlist, or declining its text consent a second time: the
// account goes, with every record holding the number — no recovery record
// (there's no profile to restore). Kept on purpose: smsOptOuts/{phone} (a
// STOP must keep being honoured), and the hashed bannedPhones /
// phoneVerificationAttempts (abuse controls; the latter expires).
// Members use Delete account in Settings.
export const leaveWaitlist = onCall({ timeoutSeconds: 60, memory: '256MiB', invoker: 'public' }, async (request): Promise<{ ok: true }> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const uid = request.auth.uid
  const root = await userRef(uid).get()
  if (root.get('onboardingComplete') === true) {
    throw new HttpsError('failed-precondition', 'Use Delete account in Settings to delete a profile.')
  }
  await deleteWaitlistedAccount(uid)
  logger.info('leaveWaitlist: account deleted')
  return { ok: true }
})

export async function deleteWaitlistedAccount(uid: string): Promise<void> {
  const entry = (await waitlistRef(uid).get()).data()
  if (typeof entry?.cityId === 'string') await interestRef(entry.cityId, uid).delete()
  await waitlistRef(uid).delete()
  // A profile started but never finished (an admitted account) goes too.
  await userRef(uid).delete()
  await clearPrivateData(uid)
  const legal = await db().collection(`users/${uid}/legalAcceptance`).listDocuments()
  await Promise.all(legal.map((d) => d.delete()))
  await getAuth()
    .deleteUser(uid)
    .catch((err: unknown) => {
      if ((err as { code?: string }).code !== 'auth/user-not-found') throw err
    })
}

// ─── adminSetCityStatus ──────────────────────────────────────────────────────

// The Cities dashboard's Unlock (→ founding), Go live and Lock. Re-checks the
// live admin claim (like the other destructive admin actions). Locking stops
// new sign-ups only: members keep everything (cityStatus.ts servesMembers).
// Going live sets the old open flags, so the existing machinery runs (trials
// start — trial.ts onMarketOpened; AI profiles retire — botRetire.ts). A live
// city can't go back to founding (its AI profiles are gone).
export const adminSetCityStatus = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ ok: true; from: CityStatus; status: CityStatus }> => {
    const adminUid = await requireAdmin(request.auth, 'adminSetCityStatus')
    await requireLiveAdmin(adminUid)
    const data = (request.data ?? {}) as Record<string, unknown>
    const city = ZYLOVE_CITIES.find((c) => c.id === data.cityId)
    if (!city) throw new HttpsError('invalid-argument', 'Unknown city.')
    const status = data.status
    if (typeof status !== 'string' || !(CITY_STATUSES as readonly string[]).includes(status)) throw new HttpsError('invalid-argument', 'Unknown status.')
    const to = status as CityStatus
    const ref = db().doc(`config/city_${city.id}`)
    const from = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const config = snap.data()
      const current = cityStatus(city.id, config)
      if (current === to) return current
      if (to === 'founding' && openFlags(config)) throw new HttpsError('failed-precondition', 'A live city can\'t go back to founding.')
      tx.set(
        ref,
        {
          ...(!snap.exists && {
            id: city.id,
            name: city.name,
            state: city.state,
            lat: city.lat,
            lng: city.lng,
            radiusMiles: city.radiusMiles,
            founderTarget: 50,
            botsActive: true,
            createdAt: FieldValue.serverTimestamp(),
          }),
          status: to,
          statusChangedAt: FieldValue.serverTimestamp(),
          statusChangedBy: adminUid,
          ...(to !== 'locked' && config?.unlockedAt == null && { unlockedAt: FieldValue.serverTimestamp() }),
          ...(to === 'live' && !openFlags(config) && { botsActive: false, discoveryOpenedAt: FieldValue.serverTimestamp() }),
        },
        { merge: true },
      )
      return current
    })
    await audit({ actor: adminUid, action: 'adminSetCityStatus', target: city.id, detail: { from, to } })
    return { ok: true, from, status: to }
  },
)

// ─── onCityStatusChanged ─────────────────────────────────────────────────────

// A city's status changing: everyone whose market it is gets their
// entitlement recomputed (pre-launch Elite follows the founding period), and
// an unlock admits everyone waiting for it and texts the ones who consented.
export const onCityStatusChanged = onDocumentWritten(
  { document: 'config/{docId}', timeoutSeconds: 540, memory: '512MiB', secrets: SMS_SECRETS },
  async (event) => {
    const { docId } = event.params
    const city = ZYLOVE_CITIES.find((c) => `city_${c.id}` === docId)
    if (!city) return
    const before = cityStatus(city.id, event.data?.before.data())
    const after = cityStatus(city.id, event.data?.after.data())
    if (before === after) return
    if (!admitsSignups(before) && admitsSignups(after)) {
      const config = event.data?.after.data()
      const admitted = await admitWaitlist(city.id, foundingPeriod(city.id, config), config)
      logger.info('onCityStatusChanged: waitlist admitted', { city: city.id, ...admitted })
    }
    const members = await db().collection('userLocations').where('marketCityId', '==', city.id).select().get()
    const { refreshPlayAccess } = await import('./playAccess')
    for (const d of members.docs) if (!/^(zbot|seed)-/.test(d.id)) await refreshPlayAccess(d.id).catch(() => {})
    const texted = await sendWaitlistTexts()
    logger.info('onCityStatusChanged', { city: city.id, before, after, refreshed: members.size, texted })
  },
)

// Everyone waiting for the city: admitted (onboarding at their next sign-in),
// and queued for the activation notice if they consented. Unlocked into its
// founding period: the first in its founder line (the circle's size) get the
// 72-hour head start.
export async function admitWaitlist(
  cityId: string,
  founding: boolean,
  config: DocumentData | undefined,
): Promise<{ admitted: number; headStart: number }> {
  const waiting = (await db().collection('cityWaitlist').where('cityId', '==', cityId).get()).docs.filter((d) => d.get('admittedAt') == null)
  const at = Timestamp.now()
  let headStart: string[] = []
  const until = Timestamp.fromMillis(at.toMillis() + HEAD_START_MS)
  if (founding) {
    const target = typeof config?.founderTarget === 'number' ? config.founderTarget : DEFAULT_FOUNDER_TARGET
    const line = await db().collection(`founderInterest/${cityId}/requests`).orderBy('at').limit(target * 2).get()
    headStart = line.docs.map((d) => d.id)
    if (headStart.length) await db().doc(`config/city_${cityId}`).set({ founderHeadStartUntil: until }, { merge: true })
  }
  const first = new Set(headStart)
  for (let i = 0; i < waiting.length; i += 100) {
    const chunk = waiting.slice(i, i + 100)
    const accounts = await db().getAll(...chunk.map((d) => accountRef(d.id)))
    const batch = db().batch()
    chunk.forEach((d, j) => {
      batch.update(d.ref, { admittedAt: at, textState: hasTextConsent(accounts[j]?.data(), null) ? 'pending' : 'none' })
      const hs = first.has(d.id) ? { founderHeadStart: { cityId, until } } : {}
      batch.set(internalRef(d.id), { admission: { status: 'admitted', cityId, at, via: 'unlock' }, ...hs }, { merge: true })
      // The owner's read-only copy (the app's founder offer checks it).
      if (first.has(d.id)) batch.set(accountRef(d.id), hs, { merge: true })
    })
    await batch.commit()
  }
  return { admitted: waiting.length, headStart: headStart.length }
}

// The queued activation notices, one at a time, up to the configured batch
// and what's left of today's cap (config/waitlistTexts, sms.ts). Each is
// claimed first (textState 'sending'), so two runs never text the same
// person; failures retry on the next sweep.
export async function sendWaitlistTexts(): Promise<number> {
  const cfg = await loadWaitlistTextConfig()
  if (!cfg.enabled) return 0
  const day = new Date().toISOString().slice(0, 10)
  const counter = db().doc('config/waitlistTexts')
  const today = await counter.get().then((s) => (s.get('sentDay') === day ? Number(s.get('sentToday') ?? 0) : 0))
  const max = Math.min(cfg.batchSize, cfg.dailyCap - today)
  if (max <= 0) return 0
  const queued = await db().collection('cityWaitlist').where('textState', '==', 'pending').limit(max).get()
  let sent = 0
  for (const d of queued.docs) {
    const claimed = await db().runTransaction(async (tx) => {
      const cur = await tx.get(d.ref)
      if (cur.get('textState') !== 'pending') return false
      tx.update(d.ref, { textState: 'sending' })
      return true
    })
    if (!claimed) continue
    const uid = d.id
    const [user, account] = await Promise.all([getAuth().getUser(uid).catch(() => null), accountRef(uid).get()])
    const phone = user?.phoneNumber ?? null
    // Consent on the number they still sign in with, not opted out since.
    if (!phone || !hasTextConsent(account.data(), phone)) {
      await d.ref.update({ textState: 'skipped' })
      continue
    }
    const result = await textWaitlister(phone, WAITLIST_ACTIVATED_TEXT)
    const attempts = Number(d.get('textAttempts') ?? 0) + 1
    await d.ref.update(
      result === 'sent'
        ? { textState: 'sent', textedAt: FieldValue.serverTimestamp(), textAttempts: attempts }
        : result === 'opted_out' || attempts >= MAX_TEXT_ATTEMPTS
          ? { textState: 'skipped', textAttempts: attempts }
          : { textState: 'pending', textAttempts: attempts },
    )
    if (result === 'sent') sent++
    if (TEXT_GAP_MS) await new Promise((r) => setTimeout(r, TEXT_GAP_MS))
  }
  if (sent) await counter.set({ sentDay: day, sentToday: today + sent }, { merge: true })
  return sent
}

// Every 30 minutes: the texts a run left over (more than one batch, or retries).
export const waitlistTextSweep = onSchedule(
  { schedule: 'every 30 minutes', timeoutSeconds: 540, memory: '256MiB', secrets: SMS_SECRETS },
  async () => {
    const sent = await sendWaitlistTexts()
    if (sent) logger.info('waitlistTextSweep', { sent })
  },
)
