// Blocks after the review fixes (2026-10-09: C1, H3, H5). Used by
// scripts/migrate-blocks.mjs and the regression suite
// (e2e/tests/41-review-blocks.spec.mjs).
//
//   H5  blocked chats, still only blocked (not unmatched), blocked less than
//       30 days ago and not kept for anyone yet: kept read-only for BOTH
//       people until 30 days after the block (preservedFor, preservedUntil,
//       preservedForReport: false), with both chat public keys (chatKeys) —
//       what blockPair now writes. Older blocks are left as they are (the
//       window has passed).
//   H3  Explore: a block someone placed in one mode hid the other person from
//       them in both (exploreState/{blocker}.blocked). Moved to that mode's
//       list ({mode}.blocked); the person blocked keeps the blocker in their
//       `blocked` (both modes). Records with no mode or no blocker recorded
//       stay as they are (both modes).
//   C1  Counted only — the data can't say whether a block was taken over
//       (a takeover rewrote both records and the match consistently):
//       blocked matches whose blocker isn't the one the block records name (or each blocked the other: one record per pair before),
//       and pairs whose two records disagree, are counted for a look by hand.
//
// Pure decisions come from functions/lib/blockCore.js (unit-tested). Every
// doc changed is returned in `backup` (path → data) before anything is
// written. Idempotent: a second run finds nothing to do.

import { createRequire } from 'node:module'

const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const { blockModes } = require(new URL('../../functions/lib/blockCore.js', import.meta.url).pathname)

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const COUNTS = [
  'block record pairs',
  'pairs with one record only',
  'pairs whose two records name different blockers (look by hand)',
  'records with no blocker or no mode (both modes, left as they are)',
  'blockers whose Explore hide moves to one mode',
  'blocked matches (Spark)',
  'blocked matches (Play)',
  'blocked matches whose blocker differs from the block records (a C1 takeover, or each blocked the other — look by hand)',
  'blocked chats kept read-only for both (blocked < 30 days ago)',
  'blocked chats left (unmatched, already kept, older, or no block time)',
]

const toMillis = (v) => (typeof v === 'number' ? v : typeof v?.toMillis === 'function' ? v.toMillis() : 0)
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

export async function planBlocks({ db, now = Date.now() }) {
  const plan = { explore: [], matches: [], backup: {}, counts: Object.fromEntries(COUNTS.map((k) => [k, 0])) }
  const count = (k, n = 1) => (plan.counts[k] += n)
  const keep = (snap) => {
    if (snap.exists && !plan.backup[snap.ref.path]) plan.backup[snap.ref.path] = snap.data()
  }

  // ─── Block records, by pair ───
  const pairs = new Map()
  for (const d of (await db.collectionGroup('blockedUsers').get()).docs) {
    const owner = d.ref.parent.parent
    if (owner?.parent.id !== 'users') continue
    const key = [owner.id, d.id].sort().join('|')
    pairs.set(key, [...(pairs.get(key) ?? []), { holder: owner.id, other: d.id, data: d.data() }])
  }
  const blockerOf = new Map() // pair key → the uid the records name
  for (const [key, recs] of pairs) {
    count('block record pairs')
    if (recs.length === 1) count('pairs with one record only')
    const by = [...new Set(recs.map((r) => r.data.blockedBy))]
    if (by.length > 1) {
      count('pairs whose two records name different blockers (look by hand)')
      continue
    }
    const blocker = by[0]
    const users = key.split('|')
    const modes = blockModes(recs[0].data)
    if (typeof blocker !== 'string' || !users.includes(blocker) || modes === null) {
      count('records with no blocker or no mode (both modes, left as they are)')
      if (typeof blocker === 'string') blockerOf.set(key, blocker)
      continue
    }
    blockerOf.set(key, blocker)
    const target = users.find((u) => u !== blocker)
    const ref = db.doc(`exploreState/${blocker}`)
    const state = await ref.get()
    if (!list(state.get('blocked')).includes(target)) continue
    keep(state)
    count('blockers whose Explore hide moves to one mode')
    plan.explore.push({ blocker, target, modes })
  }

  // ─── Blocked matches ───
  for (const col of ['matches', 'playMatches']) {
    const play = col === 'playMatches'
    for (const d of (await db.collection(col).where('isBlocked', '==', true).get()).docs) {
      const m = d.data()
      count(play ? 'blocked matches (Play)' : 'blocked matches (Spark)')
      // Who's who: Spark by uid; Play by Play ID (server-only record).
      const members = play ? ((await db.doc(`playMatchMembers/${d.id}`).get()).data() ?? {}) : null
      const ids = play ? (members.ids ?? {}) : null
      const pairUids = play ? list(members.users) : list(m.pairUsers ?? m.users)
      const idOf = (u) => (play ? ids[u] ?? null : u)
      const uidOfId = (x) => (play ? Object.keys(ids).find((u) => ids[u] === x) ?? null : x)
      if (pairUids.length === 2) {
        const recorded = blockerOf.get([...pairUids].sort().join('|'))
        const blocker = uidOfId(m.blockedBy)
        if (recorded && blocker && recorded !== blocker) count('blocked matches whose blocker differs from the block records (a C1 takeover, or each blocked the other — look by hand)')
      }
      const at = toMillis(m.blockedAt)
      const live = m.unmatchedAt === undefined || m.unmatchedAt === null
      const readers = play ? list(m.players) : list(m.users)
      if (!live || Array.isArray(m.preservedFor) || !at || at + WINDOW_MS <= now || readers.length !== 2 || pairUids.length !== 2) {
        count('blocked chats left (unmatched, already kept, older, or no block time)')
        continue
      }
      const chatKeys = {}
      for (const u of pairUids) {
        const id = idOf(u)
        if (!id) continue
        const key = play ? (await db.doc(`playProfiles/${id}`).get()).get('publicPlayKey') : (await db.doc(`users/${u}`).get()).get('publicKey')
        if (typeof key === 'string' && key.length > 0 && key.length <= 100) chatKeys[id] = key
      }
      keep(d)
      count('blocked chats kept read-only for both (blocked < 30 days ago)')
      plan.matches.push({ path: d.ref.path, preservedFor: [...readers].sort(), until: at + WINDOW_MS, chatKeys })
    }
  }
  return plan
}

export function summaryBlocks(plan) {
  return { ...plan.counts, 'docs backed up before any write': Object.keys(plan.backup).length }
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export async function applyBlocks({ db, FieldValue, Timestamp }, plan) {
  let n = 0
  const writes = [
    ...plan.explore.map((e) => (batch) =>
      batch.set(
        db.doc(`exploreState/${e.blocker}`),
        { blocked: FieldValue.arrayRemove(e.target), ...Object.fromEntries(e.modes.map((m) => [m, { blocked: FieldValue.arrayUnion(e.target) }])) },
        { merge: true },
      )),
    ...plan.matches.map((m) => (batch) =>
      batch.update(db.doc(m.path), {
        preservedFor: m.preservedFor,
        preservedUntil: Timestamp.fromMillis(m.until),
        preservedForReport: false,
        ...(Object.keys(m.chatKeys).length ? { chatKeys: m.chatKeys } : {}),
      })),
  ]
  for (let i = 0; i < writes.length; i += 200) {
    const batch = db.batch()
    for (const w of writes.slice(i, i + 200)) {
      w(batch)
      n++
    }
    await batch.commit()
  }
  return n
}
