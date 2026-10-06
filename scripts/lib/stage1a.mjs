// Stage 1a data split, one user at a time. Used by scripts/migrate-stage1a.mjs
// and by the regression suite (which seeds users in the old layout and
// migrates them with this same code).
//
// Moves every non-profile field off users/{uid} (readable by every signed-in
// user) into the homes functions/src/userData.ts describes, and turns the
// isAdmin field into the `admin` auth claim. Values already in a new home win
// over the root copy (the functions write there from the moment they're
// deployed). Field lists come from the compiled functions (functions/lib), so
// the migration and the server agree.
//
// Not touched: bots (zbot-/seed-: public fixtures, seeded with their city on
// the root doc; getDistances reads it there). Deleted accounts only lose the
// moved fields — their recovery record (deletedAccounts) already keeps what
// a restore needs — and any private docs they still have.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const lib = (name) => require(new URL(`../../functions/lib/${name}.js`, import.meta.url).pathname)
const fields = lib('userData')
const { getNearestCity } = lib('cities')

const GRID_DEG = 0.05
const snap = (v) => Math.round(Math.round(v / GRID_DEG) * GRID_DEG * 1000) / 1000
const SETTINGS_KEYS = new Set(['smsNotificationsEnabled', 'smsNotifications', 'smsQuietHours', 'photoAnalysisConsent'])

export const isBotUid = (uid) => uid.startsWith('zbot-') || uid.startsWith('seed-')

export const MOVED_FIELDS = [
  ...fields.INTERNAL_FIELDS,
  ...fields.ACCOUNT_FIELDS,
  ...fields.SETTINGS_FIELDS,
  ...fields.IDENTITY_FIELDS,
  ...fields.LOCATION_FIELDS,
  ...fields.DROPPED_FIELDS,
]

const pick = (root, list, existing) => {
  const out = {}
  for (const f of list) if (root[f] !== undefined && existing?.[f] === undefined) out[f] = root[f]
  return out
}

// What migrating this user would write. Pure: no I/O. `existing` holds the
// new-home docs as they are now ({ internal, account, settings, identity,
// location }, each data or undefined).
export function planUser(uid, root, existing) {
  const onRoot = MOVED_FIELDS.filter((f) => root[f] !== undefined)
  const plan = { uid, onRoot, writes: {}, admin: root.isAdmin === true, deleted: root.isDeleted === true }
  if (plan.deleted) return plan

  const internal = pick(root, fields.INTERNAL_FIELDS, existing.internal)
  if (plan.admin) internal.admin = true
  if (Object.keys(internal).length) plan.writes.internal = internal

  const settings = pick(root, fields.SETTINGS_FIELDS.filter((f) => SETTINGS_KEYS.has(f)), existing.settings)
  if (Object.keys(settings).length) plan.writes.settings = settings

  const identity = pick(root, fields.IDENTITY_FIELDS, existing.identity)
  if (Object.keys(identity).length) plan.writes.identity = identity

  // private/account: moved fields, plus the plan mirror and billing flag
  // (what mirrorPlan keeps up to date from here on).
  const account = pick(root, fields.ACCOUNT_FIELDS, existing.account)
  const mergedPlan = { ...root, ...(existing.internal ?? {}) }
  for (const f of fields.PLAN_FIELDS) {
    if (mergedPlan[f] !== undefined && existing.account?.[f] === undefined) account[f] = mergedPlan[f]
  }
  if (existing.account?.hasBillingAccount === undefined) {
    account.hasBillingAccount = typeof mergedPlan.stripeCustomerId === 'string' && mergedPlan.stripeCustomerId !== ''
  }

  // Location: snapped, market locked now (the nearest launch city, if any).
  if (!existing.location && typeof root.locationLat === 'number' && typeof root.locationLng === 'number') {
    const lat = snap(root.locationLat)
    const lng = snap(root.locationLng)
    const marketCityId = getNearestCity(lat, lng)?.id ?? null
    plan.writes.location = { lat, lng, marketCityId, changes: [], updatedAt: root.locationUpdatedAt ?? null }
    if (existing.account?.location === undefined) {
      account.location = {
        lat,
        lng,
        label: typeof root.locationLabel === 'string' && root.locationLabel ? root.locationLabel : null,
        marketCityId,
        updatedAt: root.locationUpdatedAt ?? null,
      }
    }
  }
  if (Object.keys(account).length) plan.writes.account = account
  return plan
}

// Applies a plan: new homes first, then the admin claim, then the root scrub.
export async function applyPlan({ db, auth, FieldValue, Timestamp }, plan) {
  const { uid, writes } = plan
  const batch = db.batch()
  const now = Timestamp.now()
  if (writes.internal) batch.set(db.doc(`userInternal/${uid}`), writes.internal, { merge: true })
  if (writes.settings) batch.set(db.doc(`users/${uid}/private/settings`), writes.settings, { merge: true })
  if (writes.identity) batch.set(db.doc(`users/${uid}/private/identity`), writes.identity, { merge: true })
  if (writes.location) batch.set(db.doc(`userLocations/${uid}`), { ...writes.location, updatedAt: writes.location.updatedAt ?? now })
  if (writes.account) {
    const account = { ...writes.account }
    if (account.location) account.location = { ...account.location, updatedAt: account.location.updatedAt ?? now }
    batch.set(db.doc(`users/${uid}/private/account`), account, { merge: true })
  }
  if (plan.deleted) {
    for (const d of ['account', 'settings', 'identity']) batch.delete(db.doc(`users/${uid}/private/${d}`))
    batch.delete(db.doc(`userInternal/${uid}`))
    batch.delete(db.doc(`userLocations/${uid}`))
  }
  if (plan.onRoot.length) batch.update(db.doc(`users/${uid}`), Object.fromEntries(plan.onRoot.map((f) => [f, FieldValue.delete()])))
  await batch.commit()
  if (plan.admin && !plan.deleted) {
    // Only a missing auth user is skipped; anything else must fail loudly.
    const user = await auth.getUser(uid).catch((err) => {
      if (err?.code === 'auth/user-not-found') return null
      throw err
    })
    if (user) await auth.setCustomUserClaims(uid, { ...(user.customClaims ?? {}), admin: true })
  }
}

// Reads the user's new-home docs.
export async function loadExisting(db, uid) {
  const [internal, account, settings, identity, location] = await db.getAll(
    db.doc(`userInternal/${uid}`),
    db.doc(`users/${uid}/private/account`),
    db.doc(`users/${uid}/private/settings`),
    db.doc(`users/${uid}/private/identity`),
    db.doc(`userLocations/${uid}`),
  )
  return { internal: internal.data(), account: account.data(), settings: settings.data(), identity: identity.data(), location: location.data() }
}

export async function migrateUser(deps, uid, root) {
  const plan = planUser(uid, root, await loadExisting(deps.db, uid))
  await applyPlan(deps, plan)
  return plan
}
