// Stage B data migration. Used by scripts/migrate-stageB.mjs and the
// regression suite.
//
//   pairs/{id}: who liked whom (userALiked / userBLiked), matched, matchedAt,
//     initiatedBy and isBot come off the pair doc, which both people can read
//     (a Spark-only partner could see a Play like). The likes move to the
//     server-only pairs/{id}/likes/{mode}: the mode from the match if there
//     is one, else from the like-queue entry the like left, else Spark.
//   users/{uid}: founderStatus and founderThreadMeta (message previews) move
//     to private/account; founderLastActiveAt, founderWarningSentAt,
//     founderRevokedAt, founderConvertedAt and founderStatusAcceptedAt are
//     dropped (founderRecords/{uid} has them).

const PAIR_FIELDS = ['userALiked', 'userBLiked', 'matched', 'matchedAt', 'initiatedBy', 'isBot']
const FOUNDER_MOVE = ['founderStatus', 'founderThreadMeta']
const FOUNDER_DROP = ['founderLastActiveAt', 'founderWarningSentAt', 'founderRevokedAt', 'founderConvertedAt', 'founderStatusAcceptedAt']

export async function planStageB(db) {
  const plan = { pairs: [], users: [], counts: {} }
  const count = (k, n = 1) => (plan.counts[k] = (plan.counts[k] ?? 0) + n)

  for (const p of (await db.collection('pairs').get()).docs) {
    const d = p.data()
    const fields = PAIR_FIELDS.filter((f) => d[f] !== undefined)
    if (!fields.length) continue
    const likes = { spark: [], play: [] }
    const liked = [d.userALiked === true ? d.userA : null, d.userBLiked === true ? d.userB : null].filter((u) => typeof u === 'string')
    if (liked.length) {
      const match = (await db.doc(`matches/${p.id}`).get()).data()
      for (const liker of liked) {
        const other = liker === d.userA ? d.userB : d.userA
        let mode = null
        if (match && typeof match.mode === 'string') mode = match.mode === 'play' ? 'play' : 'spark'
        else {
          const entry = (await db.doc(`users/${other}/likeQueue/${liker}`).get()).data()
          if (entry) mode = entry.mode === 'play' ? 'play' : 'spark'
        }
        if (!mode) {
          mode = 'spark'
          count('likes with no recorded mode (→ spark)')
        }
        likes[mode].push(liker)
        count(`${mode} likes moved`)
      }
    }
    plan.pairs.push({ id: p.id, fields, likes })
    count('pair docs scrubbed')
  }

  for (const u of (await db.collection('users').get()).docs) {
    const d = u.data()
    const move = Object.fromEntries(FOUNDER_MOVE.filter((f) => d[f] !== undefined).map((f) => [f, d[f]]))
    const drop = [...FOUNDER_MOVE, ...FOUNDER_DROP].filter((f) => d[f] !== undefined)
    if (!drop.length) continue
    plan.users.push({ uid: u.id, move, drop })
    count('public docs with founder fields scrubbed')
    if (move.founderThreadMeta) count('founder thread summaries moved to private/account')
  }
  return plan
}

export async function applyStageB({ db, FieldValue }, plan) {
  const writes = []
  for (const p of plan.pairs) {
    for (const mode of ['spark', 'play']) {
      if (p.likes[mode].length) writes.push((b) => b.set(db.doc(`pairs/${p.id}/likes/${mode}`), { likedBy: FieldValue.arrayUnion(...p.likes[mode]) }, { merge: true }))
    }
    writes.push((b) => b.update(db.doc(`pairs/${p.id}`), Object.fromEntries(p.fields.map((f) => [f, FieldValue.delete()]))))
  }
  for (const u of plan.users) {
    if (Object.keys(u.move).length) writes.push((b) => b.set(db.doc(`users/${u.uid}/private/account`), u.move, { merge: true }))
    writes.push((b) => b.update(db.doc(`users/${u.uid}`), Object.fromEntries(u.drop.map((f) => [f, FieldValue.delete()]))))
  }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch()
    for (const w of writes.slice(i, i + 400)) w(batch)
    await batch.commit()
  }
  return { writes: writes.length }
}
