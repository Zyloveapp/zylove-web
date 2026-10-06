// Stage 2 (Play sealing, F-004) data migration. Used by
// scripts/migrate-stage2.mjs and the regression suite.
//
//   users/{uid} (bots included)
//     • Play profile fields → playProfile/data (the Play profile's own values
//       win, except the enforced Play name, its timestamp and Play
//       visibility, which the public doc held authoritatively); with no Play
//       profile they're dropped (reported)
//     • intent / onboardingPath / mode / intentionAnswers → private/profile
//       (existing values win)
//     • Play photos mirrored onto a Play-only account's photoURLs removed
//     • all of the above deleted from the public doc
//     • userInternal Play flags computed (functions/lib/playAccess.js)
//   pairs/{id}: playScore / playBreakdown / tier1Play → pairs/{id}/modes/play
//     when both people have Play access, otherwise deleted
//   matches/{id}: mode 'spark' where missing; a Spark match's playScore deleted
//   users/{uid}/likeQueue/{liker}: mode 'spark' where missing; a Play like's
//     likerProfile rebuilt from the liker's Play profile (never Spark data)

import { createRequire } from 'node:module'

const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const lib = (name) => require(new URL(`../../functions/lib/${name}.js`, import.meta.url).pathname)
const { PLAY_ROOT_FIELDS, PRIVATE_PROFILE_FIELDS } = lib('userData')
const { computeFlags } = lib('playAccess')

const isBot = (uid) => uid.startsWith('zbot-')
const PLAY_PAIR_FIELDS = ['playScore', 'playBreakdown', 'tier1Play']
// Root values that win over the Play profile's copies.
const ROOT_WINS = new Set(['playDisplayName', 'playDisplayNameUpdatedAt', 'playVisibility'])
// Root field → Play profile field, where the names differ.
const RENAME = { playGoDeeper: 'goDeeper' }
// Never carried over (no meaning on the Play profile).
const DROP_ONLY = new Set(['openToCrossover', 'playPassExpiresAt'])

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [])

// ─── Plan ────────────────────────────────────────────────────────────────────

async function planStage2Users(db, onlyUids) {
  const users = onlyUids
    ? (await db.getAll(...onlyUids.map((u) => db.doc(`users/${u}`)))).filter((d) => d.exists)
    : (await db.collection('users').get()).docs
  const plan = { users: [], counts: {}, access: new Map() }
  const count = (k, n = 1) => (plan.counts[k] = (plan.counts[k] ?? 0) + n)
  const access = plan.access

  for (const u of users) {
    const uid = u.id
    const root = u.data()
    const [playSnap, profileSnap, internalSnap] = await db.getAll(
      db.doc(`users/${uid}/playProfile/data`),
      db.doc(`users/${uid}/private/profile`),
      db.doc(`userInternal/${uid}`),
    )
    const play = playSnap.data()
    const existingMeta = profileSnap.data() ?? {}

    const playFields = PLAY_ROOT_FIELDS.filter((f) => root[f] !== undefined)
    const metaFields = PRIVATE_PROFILE_FIELDS.filter((f) => root[f] !== undefined)

    // Play profile copies.
    const toPlay = {}
    let droppedNoProfile = 0
    for (const f of playFields) {
      if (DROP_ONLY.has(f)) continue
      if (!play) {
        droppedNoProfile++
        continue
      }
      const target = RENAME[f] ?? f
      if (f === 'playPromptAnswers' && (play.playPromptAnswers !== undefined || play.promptAnswers !== undefined)) continue
      if (ROOT_WINS.has(f) || play[target] === undefined) toPlay[target] = root[f]
    }
    // Play profiles from before the finished flag (mobile-era) that are in
    // use — a published photo — count as finished, so their owners keep Play.
    if (play && play.playOnboardingComplete !== true && strings(play.photoURLs).length > 0) {
      toPlay.playOnboardingComplete = true
      count('older Play profiles marked finished (have photos)')
    }
    // Private profile.
    const toMeta = {}
    for (const f of metaFields) if (existingMeta[f] === undefined) toMeta[f] = root[f]
    // Play photos on a Play-only account's public doc (since Stage 1b every
    // user photo is a path, so a Play one is photos/{uid}/play/…).
    const rootPhotos = strings(root.photoURLs)
    const keepPhotos = isBot(uid) ? rootPhotos : rootPhotos.filter((p) => !p.startsWith(`photos/${uid}/play/`))
    // Play flags (bots: by prefix, nothing stored).
    const flags = isBot(uid) ? null : computeFlags(root, internalSnap.data(), play ? { ...play, ...toPlay } : undefined)
    access.set(uid, isBot(uid) ? true : flags.playAccess)

    const entry = {
      uid,
      toPlay: Object.keys(toPlay).length ? toPlay : null,
      toMeta: Object.keys(toMeta).length ? toMeta : null,
      scrub: [...playFields, ...metaFields],
      photos: keepPhotos.length !== rootPhotos.length ? keepPhotos : null,
      flags,
    }
    plan.users.push(entry)
    if (entry.scrub.length) count(isBot(uid) ? 'bot public docs scrubbed' : 'public docs scrubbed')
    if (entry.toPlay) count('Play profiles given root fields')
    if (droppedNoProfile) count('Play fields dropped (no Play profile)', droppedNoProfile)
    if (entry.toMeta) count('private/profile docs written')
    if (entry.photos) count('Play photos removed from a public doc', rootPhotos.length - keepPhotos.length)
    if (flags) count(flags.playAccess ? 'users with Play access' : flags.playEntitled ? 'entitled, no finished Play profile' : 'users without Play')
  }
  return plan
}

export async function planStage2(db) {
  const users = await planStage2Users(db)
  const plan = { users: users.users, pairs: [], matches: [], likes: [], counts: users.counts }
  const count = (k, n = 1) => (plan.counts[k] = (plan.counts[k] ?? 0) + n)
  const access = users.access

  for (const p of (await db.collection('pairs').get()).docs) {
    const d = p.data()
    const fields = PLAY_PAIR_FIELDS.filter((f) => d[f] !== undefined)
    if (!fields.length) continue
    const both = access.get(d.userA) === true && access.get(d.userB) === true
    plan.pairs.push({ id: p.id, scores: both ? Object.fromEntries(fields.map((f) => [f, d[f]])) : null, scrub: fields })
    count(both ? 'pair Play scores moved' : 'pair Play scores deleted (one side lacks Play)')
  }

  for (const m of (await db.collection('matches').get()).docs) {
    const d = m.data()
    const patch = {}
    if (d.mode === undefined) patch.mode = 'spark'
    if ((d.mode ?? 'spark') !== 'play' && d.playScore !== undefined) patch.playScore = '__DELETE__'
    if (Object.keys(patch).length) {
      plan.matches.push({ id: m.id, patch })
      count('match docs fixed')
    }
  }

  const playOf = new Map()
  const playProfileOf = async (uid) => {
    if (!playOf.has(uid)) playOf.set(uid, (await db.doc(`users/${uid}/playProfile/data`).get()).data() ?? null)
    return playOf.get(uid)
  }
  for (const q of (await db.collectionGroup('likeQueue').get()).docs) {
    const d = q.data()
    const patch = {}
    if (d.mode === undefined) patch.mode = 'spark'
    if (d.mode === 'play') {
      const p = await playProfileOf(q.id)
      patch.likerProfile = {
        displayName: p?.playDisplayName ?? '',
        age: d.likerProfile?.age ?? 0,
        photoURL: strings(p?.photoURLs)[0] ?? null,
        photoURLs: strings(p?.photoURLs),
        bio: p?.playBio ?? '',
        spiceLevel: p?.spiceLevel ?? null,
        playInterestTags: strings(p?.playInterestTags),
        verificationStatus: d.likerProfile?.verificationStatus ?? 'unverified',
      }
    }
    if (Object.keys(patch).length) {
      plan.likes.push({ path: q.ref.path, patch })
      count(d.mode === 'play' ? 'Play likes re-snapshotted from the Play profile' : 'like-queue entries given mode spark')
    }
  }
  return plan
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export async function applyStage2({ db, FieldValue }, plan) {
  const writes = []
  const del = (v) => (v === '__DELETE__' ? FieldValue.delete() : v)
  for (const u of plan.users) {
    if (u.flags) writes.push((b) => b.set(db.doc(`userInternal/${u.uid}`), u.flags, { merge: true }))
    if (u.toPlay) writes.push((b) => b.set(db.doc(`users/${u.uid}/playProfile/data`), u.toPlay, { merge: true }))
    if (u.toMeta) writes.push((b) => b.set(db.doc(`users/${u.uid}/private/profile`), u.toMeta, { merge: true }))
    const rootPatch = Object.fromEntries(u.scrub.map((f) => [f, FieldValue.delete()]))
    if (u.photos) rootPatch.photoURLs = u.photos
    if (Object.keys(rootPatch).length) writes.push((b) => b.update(db.doc(`users/${u.uid}`), rootPatch))
  }
  for (const p of plan.pairs) {
    if (p.scores) writes.push((b) => b.set(db.doc(`pairs/${p.id}/modes/play`), { ...p.scores, updatedAt: FieldValue.serverTimestamp() }))
    writes.push((b) => b.update(db.doc(`pairs/${p.id}`), Object.fromEntries(p.scrub.map((f) => [f, FieldValue.delete()]))))
  }
  for (const m of plan.matches) writes.push((b) => b.update(db.doc(`matches/${m.id}`), Object.fromEntries(Object.entries(m.patch).map(([k, v]) => [k, del(v)]))))
  for (const l of plan.likes) writes.push((b) => b.update(db.doc(l.path), l.patch))
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch()
    for (const w of writes.slice(i, i + 400)) w(batch)
    await batch.commit()
  }
  return writes.length
}

// One user's part (public-doc moves + flags) — for seeding test users.
export async function migrateUserStage2({ db, FieldValue }, uid) {
  const all = await planStage2Users(db, [uid])
  await applyStage2({ db, FieldValue }, { users: all.users, pairs: [], matches: [], likes: [], counts: all.counts })
  return all.users[0]
}
