// One-time: delete chat content left behind before the unmatch cascade
// (functions/src/matchCleanup.ts) existed. Three kinds:
//
//   soft     match docs the old web unmatch left in place (unmatchedAt set,
//            not blocked). --apply writes a pastConnections record if there
//            isn't one (real people only), then deletes the doc;
//            onMatchBehaviorUpdate purges its messages and photos.
//   orphan   matches/{id}/messages or chat-photos/{id}/ with no match doc
//            (mobile unmatches from before the cascade). --apply deletes the
//            messages, typing docs and photos directly.
//   stale    live matches holding messages/photos from an EARLIER match
//            between the same two people (sent before this match's
//            generation; see functions/src/matchGeneration.ts). --apply
//            deletes only that earlier content.
//
//   node scripts/purge-orphaned-chat-content.mjs --dry-run   report only
//   node scripts/purge-orphaned-chat-content.mjs --apply     delete
//
// Credentials: Application Default Credentials (gcloud auth
// application-default login).

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { Timestamp, getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')

const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply.')
  process.exit(1)
}
initializeApp({ credential: applicationDefault(), projectId: 'zylove', storageBucket: 'zylove.firebasestorage.app' })
const db = getFirestore()

// Same rule as functions/src/matchGeneration.ts generationOf().
const millis = (v) => (typeof v === 'number' ? v : v instanceof Timestamp ? v.toMillis() : 0)
function generationOf(m) {
  if (typeof m?.matchGeneration === 'number' && m.matchGeneration > 0) return m.matchGeneration
  const known = [millis(m?.matchedAt), millis(m?.createdAt)].filter((ms) => ms > 0)
  return known.length ? Math.min(...known) : 0
}
const participants = (m) => {
  const users = m?.users ?? m?.participants
  return Array.isArray(users) ? users : []
}
const isBot = (m) => m?.isBot === true || participants(m).some((u) => u.startsWith('zbot-') || u.startsWith('seed-'))
const uploadedAt = (f) => Date.parse(String(f.metadata.timeCreated ?? ''))

// Photos per match id, from one listing of chat-photos/.
const [files] = await getStorage().bucket().getFiles({ prefix: 'chat-photos/' })
const photosByMatch = new Map()
for (const f of files) {
  const id = f.name.split('/')[1]
  if (id) photosByMatch.set(id, [...(photosByMatch.get(id) ?? []), f])
}

// Every match id with a doc, messages, or photos.
const refs = await db.collection('matches').listDocuments()
const ids = new Set([...refs.map((r) => r.id), ...photosByMatch.keys()])

const plan = { soft: [], orphan: [], stale: [] }
for (const id of ids) {
  const ref = db.collection('matches').doc(id)
  const m = (await ref.get()).data()
  const photos = photosByMatch.get(id) ?? []
  const messages = ref.collection('messages')

  if (!m) {
    const count = (await messages.count().get()).data().count
    if (count > 0 || photos.length > 0) plan.orphan.push({ id, messages: count, photos })
    continue
  }
  const gen = generationOf(m)
  if (m.unmatchedAt && m.isBlocked !== true) {
    const count = (await messages.count().get()).data().count
    const hasRecord =
      (await db.doc(`pastConnections/${id}_${gen}`).get()).exists || (await db.doc(`pastConnections/${id}`).get()).exists
    plan.soft.push({ id, messages: count, photos, bot: isBot(m), hasRecord, match: m, gen })
    continue
  }
  if (!gen) continue
  const old = await messages.where('sentAt', '<', Timestamp.fromMillis(gen)).select().get()
  // Unknown upload time: kept, rather than risk the current conversation.
  const oldPhotos = photos.filter((f) => Number.isFinite(uploadedAt(f)) && uploadedAt(f) < gen)
  if (old.size > 0 || oldPhotos.length > 0) plan.stale.push({ id, messages: old.size, photos: oldPhotos, gen, old })
}

const short = (id) => `${id.slice(0, 6)}…${id.slice(-4)}`
const total = (rows, k) => rows.reduce((n, r) => n + (k === 'photos' ? r.photos.length : r[k]), 0)
const section = (label, rows, note) => {
  console.log(`\n${label}: ${rows.length} (${total(rows, 'messages')} messages, ${total(rows, 'photos')} photos)`)
  for (const r of rows) console.log(`  ${short(r.id)}  ${r.messages} msgs  ${r.photos.length} photos  ${note(r)}`)
}
console.log(`Scanned ${ids.size} match ids, ${files.length} chat photos.`)
section('Soft-unmatched docs', plan.soft, (r) => `${r.bot ? 'bot ' : ''}${r.hasRecord ? '' : 'no pastConnection record'}`)
section('Orphaned (no match doc)', plan.orphan, () => '')
section("Live matches holding an earlier match's content", plan.stale, (r) => `before ${new Date(r.gen).toISOString()}`)

if (!apply) {
  console.log('\nDry run — nothing deleted. Re-run with --apply to delete.')
  process.exit(0)
}

for (const r of plan.soft) {
  if (!r.bot && !r.hasRecord) {
    const users = participants(r.match)
    const sent = Object.fromEntries(users.map((u) => [u, 0]))
    const msgs = await db
      .collection(`matches/${r.id}/messages`)
      .where('sentAt', '>=', Timestamp.fromMillis(r.gen))
      .select('senderId')
      .get()
    for (const d of msgs.docs) if (d.get('senderId') in sent) sent[d.get('senderId')]++
    await db.doc(`pastConnections/${r.id}_${r.gen}`).set({
      matchId: r.id,
      generation: r.gen,
      users,
      names: Object.fromEntries(users.map((u) => [u, r.match.participantSnapshots?.[u]?.displayName ?? 'Someone'])),
      matchedAt: millis(r.match.matchedAt) || millis(r.match.createdAt),
      endedAt: millis(r.match.unmatchedAt) || Date.now(),
      mode: r.match.mode === 'play' ? 'play' : 'spark',
      messageCount: msgs.size,
      sentCounts: sent,
      ...(typeof r.match.unmatchedBy === 'string' ? { endedBy: r.match.unmatchedBy } : {}),
    })
  }
  // onMatchBehaviorUpdate purges the messages and photos.
  await db.collection('matches').doc(r.id).delete()
}
for (const r of plan.orphan) {
  const ref = db.collection('matches').doc(r.id)
  await db.recursiveDelete(ref.collection('messages'))
  await db.recursiveDelete(ref.collection('typing'))
  await Promise.all(r.photos.map((f) => f.delete({ ignoreNotFound: true })))
}
for (const r of plan.stale) {
  const writer = db.bulkWriter()
  for (const d of r.old.docs) void writer.delete(d.ref)
  await writer.close()
  await Promise.all(r.photos.map((f) => f.delete({ ignoreNotFound: true })))
}
console.log(
  `\nDone: ${plan.soft.length} soft-unmatched docs deleted (the trigger purges their content), ` +
    `${plan.orphan.length} orphans and ${plan.stale.length} earlier-match histories purged.`,
)
