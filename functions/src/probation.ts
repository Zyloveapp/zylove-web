import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { requireAdminAudited } from './audit'
import { ZYLOVE_CITIES } from './cities'
import { loadLocation } from './userData'

// T&S Phase 2 — probation for new accounts, per city, OFF by default.
//   probation/{cityId} (server-only): { enabled, days, likesPerDay, updatedAt, updatedBy }
// While a city's switch is on, accounts in it younger than `days` get at
// most `likesPerDay` likes a day and can't exchange chat photos. Nothing
// else changes, and nobody is told they're "on probation" — the limits read
// like any other.

export const PROBATION_DEFAULTS = { days: 7, likesPerDay: 5 }
const DAY_MS = 24 * 60 * 60 * 1000
const db = () => getFirestore()

export interface Probation {
  likesPerDay: number
  noChatPhotos: true
}

// Null when the account isn't on probation (the usual case: switch off).
export async function probationOf(uid: string, now = Date.now()): Promise<Probation | null> {
  const loc = await loadLocation(uid).catch(() => null)
  if (!loc?.marketCityId) return null
  const cfg = (await db().doc(`probation/${loc.marketCityId}`).get()).data()
  if (cfg?.enabled !== true) return null
  const created = (await db().doc(`userInternal/${uid}`).get()).data()?.accountCreatedAt
  if (typeof created !== 'number') return null
  const days = typeof cfg.days === 'number' && cfg.days > 0 ? cfg.days : PROBATION_DEFAULTS.days
  if (now - created >= days * DAY_MS) return null
  return { likesPerDay: typeof cfg.likesPerDay === 'number' && cfg.likesPerDay >= 0 ? cfg.likesPerDay : PROBATION_DEFAULTS.likesPerDay, noChatPhotos: true }
}

// Admin: every city's switch.
export const adminGetProbation = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  await requireAdminAudited(request.auth, { action: 'probation.view' })
  const docs = await db().getAll(...ZYLOVE_CITIES.map((c) => db().doc(`probation/${c.id}`)))
  return {
    cities: ZYLOVE_CITIES.map((c, i) => {
      const d = docs[i].data() ?? {}
      return {
        cityId: c.id,
        name: c.name,
        enabled: d.enabled === true,
        days: typeof d.days === 'number' ? d.days : PROBATION_DEFAULTS.days,
        likesPerDay: typeof d.likesPerDay === 'number' ? d.likesPerDay : PROBATION_DEFAULTS.likesPerDay,
      }
    }),
  }
})

// Admin: turn a city's switch on or off (logged with a reason).
export const adminSetProbation = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  const data = (request.data ?? {}) as Record<string, unknown>
  const cityId = typeof data.cityId === 'string' ? data.cityId : ''
  if (!ZYLOVE_CITIES.some((c) => c.id === cityId)) throw new HttpsError('invalid-argument', 'Unknown city.')
  if (typeof data.enabled !== 'boolean') throw new HttpsError('invalid-argument', 'enabled required')
  const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 500) : ''
  if (reason.length < 5) throw new HttpsError('invalid-argument', 'A reason is required.')
  const actor = await requireAdminAudited(request.auth, { action: `probation.${data.enabled ? 'on' : 'off'}`, reason, detail: { cityId } })
  await db()
    .doc(`probation/${cityId}`)
    .set({ enabled: data.enabled, ...PROBATION_DEFAULTS, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor }, { merge: true })
  return { ok: true }
})
