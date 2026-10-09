import PDFDocument = require('pdfkit')
import { randomUUID } from 'node:crypto'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { getStorage } from 'firebase-admin/storage'
import { Timestamp, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { requireAdmin, requireAdminAudited } from './audit'
import { FRANKING_KEY } from './franking'
import { parseKeys, photoPlaintext, verifyItem, type Verdict } from './frankingCore'
import { OUTCOME_RETENTION_MS, deletable, expiryFor, open, seal, type Sealed } from './lockerCore'
import { isPlayMatchId, uidNamedIn, uidOfPlayId } from './playIds'
import { reportGeneration } from './trust'
import { loadMatch, messagesPath } from './playMatch'
import { loadPlayName } from './playName'
import { REPORT_ONLY_CATEGORY_DEFS, REVIEW_CATEGORY_DEFS } from './shared/reviewCategories'
import { queueAdminAlert } from './adminAlerts'

// T&S Phase 4 — evidence capture and the locker.
//
// A reporter may attach the messages they choose (and, optionally, photos)
// to a report. Only those leave their device; the server checks each one
// against its franking commitment and tag (frankingCore.ts) and seals the
// lot with AES-256-GCM (EVIDENCE_LOCKER_KEY) in a server-only Storage file:
//   evidenceLocker/{id} (server-only)  { reportId, matchId, reporterUid,
//     reportedUid, categories, createdAt, summary, file, v, status,
//     decision, decidedAt, ncmec, appealPending, legalHold, expiresAt }
//   gs://…/evidence/{id}.sealed        the sealed items
//   evidenceOutcomes/{id}              decision record, no content, 2 years
// The reported person is never told. Admins read items at /admin/locker
// (every view audit-logged); the reporter can download their own copy as a
// PDF, made on demand and never stored. Retention in lockerCore.ts.

export const EVIDENCE_LOCKER_KEY = defineSecret('EVIDENCE_LOCKER_KEY')
const db = () => getFirestore()
const bucket = () => getStorage().bucket()
const MAX_ITEMS = 100
const MAX_TEXT = 4000
const MAX_PHOTO_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf')
const LABELS = new Map([...REVIEW_CATEGORY_DEFS, ...REPORT_ONLY_CATEGORY_DEFS].map((c) => [c.id, c.label]))

export interface EvidenceItem {
  msgId: string
  from: 'reporter' | 'reported'
  sentAt: number | null
  type: 'text' | 'photo'
  text: string | null
  photo: string | null // base64 JPEG
  verdict: Verdict
}
export interface Summary {
  items: number
  verified: number
  unverified: number
  mismatch: number
  photos: number
}

const ms = (v: unknown): number | null => (v instanceof Timestamp ? v.toMillis() : typeof v === 'number' ? v : null)
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '')

function lockerKeys() {
  return parseKeys(EVIDENCE_LOCKER_KEY.value())
}

async function readItems(file: string, v: string): Promise<EvidenceItem[]> {
  const [raw] = await bucket().file(file).download()
  return open<{ items: EvidenceItem[] }>(lockerKeys(), { ...(JSON.parse(raw.toString('utf8')) as Omit<Sealed, 'v'>), v }).items
}

// ─── Filing evidence ─────────────────────────────────────────────────────────

export const submitEvidence = onCall(
  { timeoutSeconds: 60, memory: '512MiB', invoker: 'public', secrets: [FRANKING_KEY, EVIDENCE_LOCKER_KEY] },
  async (request): Promise<{ lockerId: string; summary: Summary }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const reporter = request.auth.uid
    const data = (request.data ?? {}) as Record<string, unknown>
    const matchId = str(data.matchId)
    // F-062: in Play the reported person is named by their Play ID — and only
    // that (F-065): a uid with a Play match, or a Play ID with a Spark one, is
    // "Send the report first", the same as a wrong id.
    const reportedUid = (await uidNamedIn(matchId, data.reportedUid)) ?? ''
    const play = isPlayMatchId(matchId)
    const claimed = typeof data.generation === 'number' && data.generation > 0 ? Math.floor(data.generation) : 0
    // F-070: the report was filed under the server's generation — look it up the same way.
    const generation = reportedUid ? ((await reportGeneration(matchId, reporter, reportedUid, claimed)) ?? claimed) : claimed
    const raw = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : []
    if (!matchId || matchId.includes('/') || typeof data.reportedUid !== 'string' || !data.reportedUid) throw new HttpsError('invalid-argument', 'matchId and reportedUid required')
    if (!raw.length) throw new HttpsError('invalid-argument', 'Pick at least one message.')
    if (raw.length > MAX_ITEMS) throw new HttpsError('invalid-argument', `At most ${MAX_ITEMS} messages per report.`)
    // Evidence belongs to a report this person filed.
    const report = (await db().doc(`reports/${reporter}_${reportedUid}_${generation}`).get()).data()
    // F-097: and to this match — another conversation's messages can't be
    // pulled in under it.
    if (!reportedUid || !report || report.reporterUid !== reporter || report.matchId !== matchId) throw new HttpsError('failed-precondition', 'Send the report first.')
    const ctx = await loadMatch(matchId)
    // F-078: a live chat the reporter still has (in a kept chat, only whoever
    // it was kept for), with the reported person its other side.
    const mine = ctx ? ctx.has(reporter) && ctx.pair.includes(reportedUid) : true
    if (!mine) throw new HttpsError('permission-denied', 'Not your conversation.')
    // A sender as messages name them (a Play ID in Play) → the account.
    const senderUid = async (id: string | null): Promise<string | null> =>
      id === null ? null : play ? ((ctx?.uidOf(id) ?? (await uidOfPlayId(id))) || '?') : id

    const ids = raw.map((r) => str(r.msgId, 128)).filter((id) => id && !id.includes('/'))
    if (ids.length !== raw.length || new Set(ids).size !== ids.length) throw new HttpsError('invalid-argument', 'Bad message list.')
    const [msgs, tags] = await Promise.all([
      db().getAll(...ids.map((id) => db().doc(`${messagesPath(matchId)}/${id}`))),
      db().getAll(...ids.map((id) => db().doc(`franking/${matchId}_${id}`))),
    ])
    const keys = parseKeys(FRANKING_KEY.value())
    let total = 0
    const senders = await Promise.all(
      raw.map((_, i) => {
        const record = msgs[i].data() ?? tags[i].data()
        const id: unknown = record ? (msgs[i].data() ? record.senderId : record.sender) : null
        return senderUid(typeof id === 'string' ? id : null)
      }),
    )
    const items: EvidenceItem[] = raw.map((r, i) => {
      const msg = msgs[i].data()
      const tag = tags[i].data()
      // The message on record, or (after the chat was purged) its franking tag.
      const record: DocumentData | null = msg ?? (tag ? { fc: tag.fc, cid: tag.cid, seq: tag.seq, senderId: tag.sender } : null)
      // As committed (a Play ID in Play) for the check; the account for who's who.
      const senderId = typeof record?.senderId === 'string' ? record.senderId : null
      const sender = senders[i]
      if (sender !== null && sender !== reporter && sender !== reportedUid) throw new HttpsError('invalid-argument', 'That message isn’t from this conversation.')
      const photoB64 = typeof r.photo === 'string' ? r.photo : null
      const photo = photoB64 ? Buffer.from(photoB64, 'base64') : null
      if (photo && photo.length > MAX_PHOTO_BYTES) throw new HttpsError('invalid-argument', 'A photo is too large.')
      const text = photo ? null : str(r.plaintext, MAX_TEXT)
      total += (text?.length ?? 0) + (photo?.length ?? 0)
      const verdict: Verdict =
        record && senderId
          ? verifyItem({
              revealed: { plaintext: photo ? photoPlaintext(photo) : (text ?? ''), kf: typeof r.kf === 'string' ? r.kf : null },
              message: { fc: record.fc, cid: record.cid, seq: record.seq, senderId },
              matchId,
              msgId: ids[i],
              tag: tag ? { r: String(tag.r), v: String(tag.v), at: Number(tag.at), sender: String(tag.sender) } : null,
              keys,
            })
          : 'unverified'
      return {
        msgId: ids[i],
        // Not on record (purged, or never sent): the reporter's word, unverified.
        from: sender !== null ? (sender === reportedUid ? 'reported' : 'reporter') : r.from === 'reported' ? 'reported' : 'reporter',
        sentAt: ms(msg?.sentAt) ?? (tag ? Number(tag.at) : null),
        type: photo ? 'photo' : 'text',
        text,
        photo: photo ? photo.toString('base64') : null,
        verdict,
      }
    })
    if (total > MAX_TOTAL_BYTES) throw new HttpsError('invalid-argument', 'That’s too much to send at once — pick fewer photos.')

    const summary: Summary = {
      items: items.length,
      verified: items.filter((x) => x.verdict === 'verified').length,
      unverified: items.filter((x) => x.verdict === 'unverified').length,
      mismatch: items.filter((x) => x.verdict === 'mismatch').length,
      photos: items.filter((x) => x.type === 'photo').length,
    }
    const id = randomUUID()
    const sealed = seal(lockerKeys(), { items })
    const file = `evidence/${id}.sealed`
    await bucket().file(file).save(JSON.stringify({ iv: sealed.iv, tag: sealed.tag, data: sealed.data }), { contentType: 'application/octet-stream', resumable: false })
    const createdAt = Date.now()
    await db()
      .doc(`evidenceLocker/${id}`)
      .set({
        reportId: `${reporter}_${reportedUid}_${generation}`,
        matchId,
        reporterUid: reporter,
        reportedUid,
        categories: Array.isArray(report.categories) ? report.categories : [],
        createdAt,
        summary,
        file,
        v: sealed.v,
        status: 'open',
        decision: null,
        decidedAt: null,
        ncmec: false,
        appealPending: false,
        legalHold: null,
        ...(play ? { mode: 'play' } : {}),
        expiresAt: Timestamp.fromMillis(expiryFor({ createdAt, decidedAt: null, ncmec: false, appealPending: false }) as number),
      })
    logger.info('submitEvidence', { ...summary })
    await queueAdminAlert('evidence', { subjectUid: reporter })
    return { lockerId: id, summary }
  },
)

// ─── The reporter's copy ─────────────────────────────────────────────────────

// The lines of the reporter's PDF — no phone numbers, locations or private
// account data: names as shown in the app, times, the messages, how each
// checked out. Pure, so the content is easy to test.
export function pdfLines(input: { reportedName: string; categories: string[]; createdAt: number; reference: string; items: EvidenceItem[] }): { kind: 'title' | 'meta' | 'from' | 'text' | 'note'; text: string }[] {
  const when = (t: number | null) => (t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) : 'time unknown')
  const VERDICT: Record<Verdict, string> = {
    verified: 'Verified — matches what was sent',
    unverified: 'Unverified context — sent before message verification, or not on record',
    mismatch: "Couldn't be verified — doesn't match what was sent",
  }
  const out: { kind: 'title' | 'meta' | 'from' | 'text' | 'note'; text: string }[] = [
    { kind: 'title', text: 'Zylove — your report' },
    { kind: 'meta', text: `Reference ${input.reference.slice(0, 8)} · filed ${when(input.createdAt)}` },
    { kind: 'meta', text: `About: ${input.reportedName}` },
    { kind: 'meta', text: `What happened: ${input.categories.map((c) => LABELS.get(c) ?? c).join(', ') || '—'}` },
    { kind: 'note', text: 'Only the messages you chose were sent to the Zylove safety team. This copy was made when you asked for it and is not stored.' },
  ]
  for (const it of input.items) {
    out.push({ kind: 'from', text: `${it.from === 'reporter' ? 'You' : input.reportedName} · ${when(it.sentAt)} · ${VERDICT[it.verdict]}` })
    out.push({ kind: 'text', text: it.type === 'photo' ? '[Photo — attached to your report]' : (it.text ?? '') })
  }
  return out
}

export const getEvidencePdf = onCall(
  { timeoutSeconds: 60, memory: '512MiB', invoker: 'public', secrets: [EVIDENCE_LOCKER_KEY] },
  async (request): Promise<{ pdf: string }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const id = str((request.data as Record<string, unknown> | null)?.lockerId, 64)
    const locker = id ? (await db().doc(`evidenceLocker/${id}`).get()).data() : undefined
    if (!locker || locker.reporterUid !== request.auth.uid) throw new HttpsError('not-found', 'No such report.')
    const items = await readItems(locker.file, locker.v)
    // F-062: a Play report names them by their Play name — never the Spark one.
    const reportedName = locker.mode === 'play' || isPlayMatchId(locker.matchId)
      ? await loadPlayName(locker.reportedUid)
      : str((await db().doc(`users/${locker.reportedUid}`).get()).data()?.displayName, 60)
    const lines = pdfLines({ reportedName: str(reportedName, 60) || 'The other person', categories: locker.categories ?? [], createdAt: locker.createdAt, reference: id, items })
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 56, bottom: 56, left: 56, right: 56 } })
    doc.registerFont('body', FONT)
    doc.registerFont('bold', FONT_BOLD)
    const chunks: Buffer[] = []
    const done = new Promise<Buffer>((resolve) => {
      doc.on('data', (c: Buffer) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
    })
    let photo = 0
    const photos = items.filter((x) => x.type === 'photo')
    for (const l of lines) {
      if (l.kind === 'title') doc.font('bold').fontSize(18).fillColor('#111').text(l.text).moveDown(0.3)
      else if (l.kind === 'meta') doc.font('body').fontSize(10).fillColor('#555').text(l.text)
      else if (l.kind === 'note') doc.moveDown(0.5).font('body').fontSize(9).fillColor('#777').text(l.text).moveDown(0.8)
      else if (l.kind === 'from') doc.moveDown(0.4).font('bold').fontSize(9).fillColor('#333').text(l.text)
      else if (l.text.startsWith('[Photo') && photos[photo]?.photo) {
        try {
          doc.image(Buffer.from(photos[photo++].photo as string, 'base64'), { fit: [240, 240] })
        } catch {
          doc.font('body').fontSize(11).fillColor('#111').text(l.text)
        }
      } else doc.font('body').fontSize(11).fillColor('#111').text(l.text)
    }
    doc.end()
    return { pdf: (await done).toString('base64') }
  },
)

// ─── Admin: the locker ───────────────────────────────────────────────────────

async function names(uids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(uids)]
  const docs = unique.length ? await db().getAll(...unique.map((u) => db().doc(`users/${u}`))) : []
  return new Map(docs.map((d) => [d.id, str(d.data()?.displayName, 60) || 'Unknown']))
}

function row(id: string, d: DocumentData, n: Map<string, string>) {
  return {
    id,
    reporterUid: d.reporterUid,
    reporterName: n.get(d.reporterUid) ?? 'Unknown',
    reportedUid: d.reportedUid,
    reportedName: n.get(d.reportedUid) ?? 'Unknown',
    categories: d.categories ?? [],
    createdAt: d.createdAt,
    summary: d.summary,
    status: d.status,
    decision: d.decision ?? null,
    decidedAt: d.decidedAt ?? null,
    ncmec: d.ncmec === true,
    appealPending: d.appealPending === true,
    legalHold: d.legalHold ? { kind: d.legalHold.kind, by: d.legalHold.by, at: d.legalHold.at, reason: d.legalHold.reason } : null,
    expiresAt: ms(d.expiresAt),
  }
}

export const adminLockerList = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  const f = (request.data ?? {}) as Record<string, unknown>
  const status = f.status === 'decided' || f.status === 'held' || f.status === 'open' ? f.status : 'all'
  const category = str(f.category, 40) || null
  await requireAdminAudited(request.auth, { action: 'locker.list', detail: { status, category } })
  const snap = await db().collection('evidenceLocker').orderBy('createdAt', 'desc').limit(200).get()
  const docs = snap.docs.filter((d) => {
    const x = d.data()
    if (status === 'held' && !x.legalHold) return false
    if (status === 'open' && x.status !== 'open') return false
    if (status === 'decided' && x.status !== 'decided') return false
    return !category || (x.categories ?? []).includes(category)
  })
  const n = await names(docs.flatMap((d) => [d.get('reporterUid'), d.get('reportedUid')]))
  return { items: docs.map((d) => row(d.id, d.data(), n)) }
})

export const adminLockerDetail = onCall({ timeoutSeconds: 60, memory: '512MiB', invoker: 'public', secrets: [EVIDENCE_LOCKER_KEY] }, async (request) => {
  // F-094: the admin check comes before anything is read.
  await requireAdmin(request.auth, 'adminLockerDetail')
  const id = str((request.data as Record<string, unknown> | null)?.id, 64)
  const d = id ? (await db().doc(`evidenceLocker/${id}`).get()).data() : undefined
  await requireAdminAudited(request.auth, { action: 'locker.view', target: d?.reportedUid ?? null, detail: { id } })
  if (!d) throw new HttpsError('not-found', 'No such evidence.')
  const n = await names([d.reporterUid, d.reportedUid])
  return { ...row(id, d, n), items: await readItems(d.file, d.v) }
})

// Records the decision (and its outcome record) and starts the retention clock.
async function decide(id: string, d: DocumentData, decision: 'actioned' | 'no_action', ncmec: boolean, by: string, reason: string): Promise<void> {
  const decidedAt = Date.now()
  const exp = expiryFor({ createdAt: d.createdAt, decidedAt, ncmec, appealPending: d.appealPending === true })
  await db()
    .doc(`evidenceLocker/${id}`)
    .update({ status: 'decided', decision, decidedAt, decidedBy: by, ncmec, expiresAt: exp === null ? null : Timestamp.fromMillis(exp) })
  await db()
    .doc(`evidenceOutcomes/${id}`)
    .set({
      lockerId: id,
      reportId: d.reportId,
      reporterUid: d.reporterUid,
      reportedUid: d.reportedUid,
      categories: d.categories ?? [],
      decision,
      ncmec,
      reason: reason.slice(0, 500),
      decidedAt,
      appeal: null,
      expiresAt: Timestamp.fromMillis(decidedAt + OUTCOME_RETENTION_MS),
    })
}

export const adminLockerDecide = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  // F-094: the admin check comes before anything is read.
  await requireAdmin(request.auth, 'adminLockerDecide')
  const f = (request.data ?? {}) as Record<string, unknown>
  const id = str(f.id, 64)
  const decision = f.decision === 'actioned' || f.decision === 'no_action' ? f.decision : null
  const reason = str(f.reason, 500).trim()
  if (!id || !decision) throw new HttpsError('invalid-argument', 'id and decision required')
  if (reason.length < 5) throw new HttpsError('invalid-argument', 'A reason is required.')
  const d = (await db().doc(`evidenceLocker/${id}`).get()).data()
  const by = await requireAdminAudited(request.auth, { action: 'locker.decide', target: d?.reportedUid ?? null, reason, detail: { id, decision, ncmec: f.ncmec === true } })
  if (!d) throw new HttpsError('not-found', 'No such evidence.')
  await decide(id, d, decision, f.ncmec === true, by, reason)
  return { ok: true }
})

// A legal hold (who, when, why): nothing on hold is deleted until released.
export const adminLockerHold = onCall({ timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, async (request) => {
  // F-094: the admin check comes before anything is read.
  await requireAdmin(request.auth, 'adminLockerHold')
  const f = (request.data ?? {}) as Record<string, unknown>
  const id = str(f.id, 64)
  const hold = f.hold === true
  const kind = f.kind === 'law_enforcement' || f.kind === 'ncmec' ? f.kind : 'legal'
  const reason = str(f.reason, 500).trim()
  if (!id) throw new HttpsError('invalid-argument', 'id required')
  if (reason.length < 5) throw new HttpsError('invalid-argument', 'A reason is required.')
  const ref = db().doc(`evidenceLocker/${id}`)
  const d = (await ref.get()).data()
  const by = await requireAdminAudited(request.auth, { action: hold ? 'locker.hold' : 'locker.release', target: d?.reportedUid ?? null, reason, detail: { id, kind } })
  if (!d) throw new HttpsError('not-found', 'No such evidence.')
  await ref.update({ legalHold: hold ? { kind, by, at: Date.now(), reason } : null, ...(hold ? {} : { holdReleased: { by, at: Date.now(), reason } }) })
  return { ok: true }
})

// From the reports dashboard (adminModerate): the evidence against this
// account that's still open is decided with the same outcome.
export async function decideEvidenceFor(reportedUid: string, decision: 'actioned' | 'no_action', by: string): Promise<number> {
  const open = await db().collection('evidenceLocker').where('reportedUid', '==', reportedUid).where('status', '==', 'open').get()
  for (const d of open.docs) await decide(d.id, d.data(), decision, false, by, 'Decided from the reports dashboard')
  return open.size
}

// An appeal pauses the clock on the decided evidence about that account; its
// outcome restarts it (30 days, or a year for child-safety cases).
export async function pauseEvidenceFor(uid: string): Promise<void> {
  const snap = await db().collection('evidenceLocker').where('reportedUid', '==', uid).get()
  await Promise.all(snap.docs.map((d) => d.ref.update({ appealPending: true, expiresAt: null })))
}
export async function resumeEvidenceFor(uid: string, outcome: 'upheld' | 'overturned'): Promise<void> {
  const snap = await db().collection('evidenceLocker').where('reportedUid', '==', uid).get()
  const now = Date.now()
  for (const d of snap.docs) {
    const x = d.data()
    const exp = expiryFor({ createdAt: x.createdAt, decidedAt: x.decidedAt === null ? null : now, ncmec: x.ncmec === true, appealPending: false })
    await d.ref.update({ appealPending: false, expiresAt: exp === null ? null : Timestamp.fromMillis(exp) })
    await db().doc(`evidenceOutcomes/${d.id}`).set({ appeal: { outcome, decidedAt: now } }, { merge: true })
  }
}

// ─── Nightly: retention ──────────────────────────────────────────────────────

export const purgeEvidence = onSchedule({ schedule: '35 2 * * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB' }, async () => {
  const now = Timestamp.now()
  const lockers = await db().collection('evidenceLocker').where('expiresAt', '<=', now).get()
  let deleted = 0
  for (const d of lockers.docs) {
    const x = d.data()
    if (!deletable({ expiresAt: ms(x.expiresAt), legalHold: x.legalHold }, now.toMillis())) continue
    await bucket().file(x.file).delete({ ignoreNotFound: true })
    await d.ref.delete()
    deleted++
  }
  const counts: Record<string, number> = { evidence: deleted }
  for (const col of ['evidenceOutcomes', 'franking', 'appealTokens', 'appeals']) {
    const due = await db().collection(col).where('expiresAt', '<=', now).get()
    for (let i = 0; i < due.size; i += 400) {
      const batch = db().batch()
      due.docs.slice(i, i + 400).forEach((x) => batch.delete(x.ref))
      await batch.commit()
    }
    counts[col] = due.size
  }
  logger.info('purgeEvidence', counts)
})
