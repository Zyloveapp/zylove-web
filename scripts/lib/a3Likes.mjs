// §4.A3 anonymous likers: the data step that goes with the code. Used by
// scripts/migrate-a3-likes.mjs and the regression suite
// (e2e/tests/37-a3-anonymous-likers.spec.mjs).
//
// Like queue docs (users/{uid}/likeQueue/{likerUid | likerPlayId}) stay where
// they are — they're server-only now — so nothing is re-keyed. Each one that
// may show gets its opaque like id (likeId, lk_…) ahead of time; getLikes
// gives one on demand to any doc still without, so this step is optional and
// old and new docs work side by side. Hidden likes — the liker deleted or
// gone, suspended, blocked either way, or (Play) out of Play — are skipped:
// they'd get an id when listed again, if they ever show.
//
// F-098: every queue doc also loses `breakdown` and `dealbreakersTriggered`
// (the liker's own dealbreakers, unfiltered); onLike no longer writes them
// and nothing reads them.
//
// Every doc changed is returned in `backup` (path → the fields it changes)
// before anything is written. Idempotent.

import { randomBytes } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const LIKE_ID = /^lk_[A-Za-z0-9]{20}$/
const PLAY_ID = /^p_[A-Za-z0-9]{20}$/
// Same as functions/src/likerPreviewCore.ts newLikeId.
export function newLikeId() {
  let s = 'lk_'
  for (const b of randomBytes(20)) s += ALPHABET[b % ALPHABET.length]
  return s
}
const DETAILS = ['breakdown', 'dealbreakersTriggered']
const millis = (v) => (typeof v === 'number' ? v : v && typeof v.toMillis === 'function' ? v.toMillis() : null)

async function cached(cache, key, load) {
  if (!cache.has(key)) cache.set(key, await load())
  return cache.get(key)
}

// Why a like is hidden from `owner`, or null when it may show (same tests as
// functions/src/likerPreview.ts likerStates / likeVisible).
async function hiddenReason(db, owner, liker, playId, mode, cache) {
  if (!liker) return 'liker gone'
  const root = await cached(cache, `root:${liker}`, async () => (await db.doc(`users/${liker}`).get()).data() ?? null)
  if (!root || root.isDeleted === true) return 'liker deleted or gone'
  const internal = await cached(cache, `int:${liker}`, async () => (await db.doc(`userInternal/${liker}`).get()).data() ?? {})
  if (internal.isSuspended === true || root.isSuspended === true) return 'liker suspended'
  const [a, b] = await db.getAll(db.doc(`users/${liker}/blockedUsers/${owner}`), db.doc(`users/${owner}/blockedUsers/${liker}`))
  if (a.exists || b.exists) return 'blocked'
  if (mode === 'play' && !liker.startsWith('zbot-')) {
    const until = millis(internal.playAccessUntil)
    const access = internal.playAccess === true && (until === null || until > Date.now())
    const copy = playId ? await cached(cache, `pp:${playId}`, async () => (await db.doc(`playProfiles/${playId}`).get()).exists) : false
    if (!access || !copy) return 'liker out of Play'
  }
  return null
}

export async function planA3Likes({ db }) {
  const cache = new Map()
  const plan = { total: { spark: 0, play: 0 }, stamped: { spark: 0, play: 0 }, stamp: [], details: [], skipped: {}, backup: {} }
  for (const d of (await db.collectionGroup('likeQueue').get()).docs) {
    const owner = d.ref.parent.parent?.id
    if (!owner || d.ref.parent.parent.parent.id !== 'users') continue
    const data = d.data()
    const mode = data.mode === 'play' ? 'play' : 'spark'
    plan.total[mode]++
    const hasDetails = DETAILS.some((k) => data[k] !== undefined)
    if (hasDetails) plan.details.push(d.ref.path)
    let stamp = false
    if (LIKE_ID.test(data.likeId ?? '')) {
      plan.stamped[mode]++
    } else {
      let liker = null
      let playId = null
      if (mode === 'spark') liker = typeof data.likerUid === 'string' && data.likerUid ? data.likerUid : d.id
      else {
        playId = PLAY_ID.test(data.likerPlayId ?? '') ? data.likerPlayId : PLAY_ID.test(d.id) ? d.id : null
        liker = playId ? await cached(cache, `owner:${playId}`, async () => (await db.doc(`playIdOwners/${playId}`).get()).get('uid') ?? null) : null
      }
      const why = await hiddenReason(db, owner, liker, playId, mode, cache)
      if (why) {
        const k = `${mode}: ${why}`
        plan.skipped[k] = (plan.skipped[k] ?? 0) + 1
      } else {
        stamp = true
        plan.stamp.push({ path: d.ref.path, mode })
      }
    }
    if (stamp || hasDetails) {
      plan.backup[d.ref.path] = Object.fromEntries(['likeId', ...DETAILS].filter((k) => data[k] !== undefined).map((k) => [k, data[k]]))
    }
  }
  return plan
}

// Counts only — no ids, names or content.
export function summary(plan) {
  const out = {
    'Like queue docs (Spark)': plan.total.spark,
    'Like queue docs (Play)': plan.total.play,
    'Already have a like id (Spark)': plan.stamped.spark,
    'Already have a like id (Play)': plan.stamped.play,
    'Like ids to add (Spark)': plan.stamp.filter((s) => s.mode === 'spark').length,
    'Like ids to add (Play)': plan.stamp.filter((s) => s.mode === 'play').length,
  }
  for (const [k, n] of Object.entries(plan.skipped).sort()) out[`Skipped, hidden — ${k}`] = n
  out['F-098: docs losing breakdown / dealbreakersTriggered'] = plan.details.length
  return out
}

export async function applyA3Likes({ db, FieldValue }, plan) {
  const drop = new Set(plan.details)
  const stamp = new Set(plan.stamp.map((s) => s.path))
  const paths = [...new Set([...stamp, ...drop])]
  let writes = 0
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200)
    // A transaction, so a like id getLikes gave in the meantime is kept.
    writes += await db.runTransaction(async (tx) => {
      const snaps = await tx.getAll(...chunk.map((p) => db.doc(p)))
      let n = 0
      for (const s of snaps) {
        if (!s.exists) continue
        const update = {}
        if (stamp.has(s.ref.path) && !LIKE_ID.test(s.get('likeId') ?? '')) update.likeId = newLikeId()
        if (drop.has(s.ref.path)) for (const k of DETAILS) update[k] = FieldValue.delete()
        if (Object.keys(update).length) {
          tx.update(s.ref, update)
          n++
        }
      }
      return n
    })
  }
  return writes
}
