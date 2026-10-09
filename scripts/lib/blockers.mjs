// Final-review blockers: the data moves that go with the code. Used by
// scripts/migrate-blockers.mjs and the regression suite
// (e2e/tests/29-final-blockers.spec.mjs).
//
//   F-065   Play pair state off the uid pair: pairs/{uidA_uidB}/likes/play
//           and pairs/{uidA_uidB}/modes/play → playPairData/{pA_pB} (likedBy,
//           playScore, playBreakdown, tier1Play), then the old docs deleted.
//           A pair where either account has no Play ID (deleted, never had
//           Play) has nothing to move: its old docs are just deleted.
//   F-064   Play past connections named by a uid pair (from before F-062):
//           deleted (getPastConnections also skips them). Matthew reversed
//           decision D on 2026-10-08.
//   §4.A1   religion and politicalView: off the public users/{uid} doc into
//           the owner-only private/matching (a value already there wins).
//   F-071   a scam-blocklist hold's context (pendingPhotoURLs[].reason.match
//           / more / distance) → photoHolds/{id}; the owner's entry keeps
//           { blocklist: true }.
//
// Reported, not changed: blocks with no mode (users/{uid}/blockedUsers
// without `mode`) — whether one was placed from Play can't be told now;
// accounts under 18 or with no identity lock (F-066, read-only scan).
//
// Every doc changed or deleted is returned in `backup` (path → data) before
// anything is written; migrate-blockers.mjs saves it. Idempotent.

import { createHash } from 'node:crypto'

const PLAY_MATCH_ID = /^pm_[A-Za-z0-9]{20}$/
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [])
// Same as functions/src/photoHolds.ts photoHoldId.
export const photoHoldId = (uid, url) => createHash('sha256').update(`${uid}\n${url}`).digest('hex').slice(0, 40)
const playPairKey = (a, b) => [a, b].sort().join('_')

async function playIdOf(db, uid, cache) {
  if (!cache.has(uid)) {
    const v = (await db.doc(`playIds/${uid}`).get()).get('playId')
    cache.set(uid, typeof v === 'string' && v.startsWith('p_') ? v : null)
  }
  return cache.get(uid)
}

function ageOf(birthday, now = new Date()) {
  if (typeof birthday !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return null
  const [y, m, d] = birthday.split('-').map(Number)
  let age = now.getUTCFullYear() - y
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--
  return age
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export async function planBlockers({ db }) {
  const plan = { playPairs: [], orphanPlayDocs: [], legacyPast: [], beliefs: [], holds: [], modelessBlocks: 0, under18: 0, unlocked: 0, backup: {} }
  const ids = new Map()
  const keep = (snap) => {
    plan.backup[snap.ref.path] = snap.data()
  }

  // F-065
  const byPair = new Map()
  for (const d of (await db.collectionGroup('likes').get()).docs) {
    if (d.id !== 'play' || d.ref.parent.parent?.parent.id !== 'pairs') continue
    const pairId = d.ref.parent.parent.id
    byPair.set(pairId, { ...(byPair.get(pairId) ?? {}), likes: d })
  }
  for (const d of (await db.collectionGroup('modes').get()).docs) {
    if (d.id !== 'play' || d.ref.parent.parent?.parent.id !== 'pairs') continue
    const pairId = d.ref.parent.parent.id
    byPair.set(pairId, { ...(byPair.get(pairId) ?? {}), scores: d })
  }
  for (const [pairId, { likes, scores }] of byPair) {
    const pair = (await db.doc(`pairs/${pairId}`).get()).data()
    const users = pair && typeof pair.userA === 'string' && typeof pair.userB === 'string' ? [pair.userA, pair.userB] : pairId.split('_')
    const [pa, pb] = users.length === 2 ? await Promise.all(users.map((u) => playIdOf(db, u, ids))) : [null, null]
    if (likes) keep(likes)
    if (scores) keep(scores)
    if (!pa || !pb) {
      plan.orphanPlayDocs.push(...[likes, scores].filter(Boolean).map((s) => s.ref.path))
      continue
    }
    plan.playPairs.push({ pairId, users: [...users].sort(), key: playPairKey(pa, pb), likedBy: strings(likes?.get('likedBy')), scores: scores?.data() ?? null, old: [likes, scores].filter(Boolean).map((s) => s.ref.path) })
  }

  // F-064
  for (const d of (await db.collection('pastConnections').get()).docs) {
    const p = d.data()
    const matchId = typeof p.matchId === 'string' ? p.matchId : d.id
    if ((p.mode === 'play' || p.mode === 'entanglement') && !PLAY_MATCH_ID.test(matchId)) {
      keep(d)
      plan.legacyPast.push(d.ref.path)
    }
  }

  // §4.A1, F-066 scan
  for (const d of (await db.collection('users').get()).docs) {
    const u = d.data()
    if (u.isDeleted === true || /^(zbot|seed)-/.test(d.id)) continue
    if (u.religion !== undefined || u.politicalView !== undefined) {
      keep(d)
      const m = await db.doc(`users/${d.id}/private/matching`).get()
      if (m.exists) keep(m)
      plan.beliefs.push({ uid: d.id, religion: u.religion, politicalView: u.politicalView, matching: m.data() ?? {} })
    }
    if (u.onboardingComplete === true || u.genderIdentity != null) {
      const birthday = (await db.doc(`users/${d.id}/private/identity`).get()).get('birthday') ?? u.birthday
      const age = ageOf(birthday) ?? (typeof u.age === 'number' ? u.age : null)
      if (age !== null && age < 18) plan.under18++
      if (u.genderIdentity != null && u.identityLockedAt == null) plan.unlocked++
    }
  }

  // F-071
  const holders = [
    ...(await db.collectionGroup('private').get()).docs.filter((d) => d.id === 'account'),
    ...(await db.collection('users').get()).docs,
    ...(await db.collectionGroup('playProfile').get()).docs.filter((d) => d.id === 'data'),
  ]
  for (const d of holders) {
    const pending = Array.isArray(d.get('pendingPhotoURLs')) ? d.get('pendingPhotoURLs') : []
    if (!pending.some((p) => p?.reason?.blocklist === true && (p.reason.match || p.reason.more !== undefined || p.reason.distance !== undefined))) continue
    const uid = d.ref.path.split('/')[1]
    keep(d)
    plan.holds.push({ path: d.ref.path, uid, pending })
  }

  // Reported only
  for (const d of (await db.collectionGroup('blockedUsers').get()).docs) if (d.get('mode') === undefined) plan.modelessBlocks++
  return plan
}

export function summary(plan) {
  return {
    'F-065 Play pairs moved to playPairData': plan.playPairs.length,
    'F-065   old docs deleted after the move': plan.playPairs.reduce((n, p) => n + p.old.length, 0),
    'F-065 old Play docs with no Play IDs (deleted)': plan.orphanPlayDocs.length,
    'F-064 uid-pair Play past connections (deleted)': plan.legacyPast.length,
    '§4.A1 accounts with religion/politics on the public doc (moved)': plan.beliefs.length,
    'F-071 docs with blocklist hold context (moved)': plan.holds.length,
    'report: blocks with no mode (unchanged)': plan.modelessBlocks,
    'report: F-066 accounts under 18 (unchanged)': plan.under18,
    'report: F-066 accounts with gender but no identity lock (unchanged)': plan.unlocked,
    'docs backed up before any write': Object.keys(plan.backup).length,
  }
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export async function applyBlockers({ db, FieldValue, Timestamp }, plan) {
  let writes = 0
  for (const p of plan.playPairs) {
    const ref = db.doc(`playPairData/${p.key}`)
    const scores = p.scores ? Object.fromEntries(['playScore', 'playBreakdown', 'tier1Play'].filter((k) => p.scores[k] !== undefined).map((k) => [k, p.scores[k]])) : {}
    await ref.set({ users: p.users, ...(p.likedBy.length ? { likedBy: FieldValue.arrayUnion(...p.likedBy) } : {}), ...scores }, { merge: true })
    for (const path of p.old) await db.doc(path).delete()
    writes += 1 + p.old.length
  }
  for (const path of [...plan.orphanPlayDocs, ...plan.legacyPast]) {
    await db.doc(path).delete()
    writes++
  }
  for (const b of plan.beliefs) {
    const moved = {}
    for (const k of ['religion', 'politicalView']) if (b[k] !== undefined && b[k] !== null && b.matching[k] === undefined) moved[k] = b[k]
    if (Object.keys(moved).length) await db.doc(`users/${b.uid}/private/matching`).set(moved, { merge: true })
    await db.doc(`users/${b.uid}`).update({ religion: FieldValue.delete(), politicalView: FieldValue.delete() })
    writes += 2
  }
  for (const h of plan.holds) {
    const next = []
    for (const p of h.pending) {
      const r = p?.reason
      if (r?.blocklist === true && (r.match || r.more !== undefined || r.distance !== undefined)) {
        await db.doc(`photoHolds/${photoHoldId(h.uid, p.url)}`).set({ uid: h.uid, url: p.url, match: r.match ?? null, more: r.more ?? 0, distance: r.distance ?? null, heldAt: p.flaggedAt ?? Timestamp.now() })
        const { match, more, distance, ...rest } = r
        next.push({ ...p, reason: { ...rest, blocklist: true } })
        writes++
      } else next.push(p)
    }
    await db.doc(h.path).update({ pendingPhotoURLs: next })
    writes++
  }
  return writes
}
