import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { Timestamp, getFirestore, type DocumentData, type Query, type QueryDocumentSnapshot, type QuerySnapshot } from 'firebase-admin/firestore'

// Retention periods promised by the privacy policy, for collections nothing
// else expires. Each is purged by the field its writers stamp (the last
// write, where a doc is updated in place), in that field's type: a doc
// without a value of that type is "undated" — counted, never deleted.
//
// Ships in dry run: real deletes only while config/retention { enabled:
// true } (server-only; clients can read config/*, not write it). Otherwise
// purgeRetention logs what it would delete. Counts only, never ids.
// scripts/retention-dry-run.mjs runs the same code read-only.

const DAY_MS = 24 * 60 * 60 * 1000
const YEAR_MS = 365 * DAY_MS
const PAGE = 400

export type Kind = 'timestamp' | 'millis'
export interface DateField {
  field: string
  kind: Kind
}
export interface RetentionEntry extends DateField {
  collection: string
  maxAgeMs: number
  // A second date field, for a collection whose writers stamp one or the
  // other; a doc is due only when every date it carries is past the cutoff.
  alt?: DateField
  // report: open, held or still in the evidence locker. block: the only
  // record of a block (no users/{uid}/blockedUsers mirror).
  protect?: 'report' | 'block'
}

export const RETENTION: RetentionEntry[] = [
  // Latest report time (millis; recordReport and the legacy reportUser).
  { collection: 'reports', field: 'reportedAt', kind: 'millis', maxAgeMs: 2 * YEAR_MS, protect: 'report' },
  { collection: 'reviews', field: 'createdAt', kind: 'timestamp', maxAgeMs: 2 * YEAR_MS },
  { collection: 'unmatchReasons', field: 'createdAt', kind: 'timestamp', maxAgeMs: 2 * YEAR_MS },
  { collection: 'scoreEvents', field: 'createdAt', kind: 'timestamp', maxAgeMs: 2 * YEAR_MS },
  // Upserted review/risk flags carry updatedAt; legacy unmatch flags createdAt.
  { collection: 'reviewQueue', field: 'updatedAt', kind: 'timestamp', alt: { field: 'createdAt', kind: 'timestamp' }, maxAgeMs: 2 * YEAR_MS },
  { collection: 'vibeChecks', field: 'createdAt', kind: 'timestamp', maxAgeMs: 2 * YEAR_MS },
  // Legacy (mobile-era, no writer left); docs without createdAt stay undated.
  { collection: 'blocks', field: 'createdAt', kind: 'timestamp', maxAgeMs: 2 * YEAR_MS, protect: 'block' },
  // Public web forms (createdAt == request.time in firestore.rules).
  { collection: 'contactMessages', field: 'createdAt', kind: 'timestamp', maxAgeMs: YEAR_MS },
  { collection: 'waitlist', field: 'createdAt', kind: 'timestamp', maxAgeMs: YEAR_MS },
  { collection: 'foundingApplications', field: 'createdAt', kind: 'timestamp', maxAgeMs: YEAR_MS },
  // Counters, by last write (takeQuota / incrementMessageCap stamp updatedAt).
  { collection: 'usage', field: 'updatedAt', kind: 'timestamp', maxAgeMs: 2 * YEAR_MS },
  { collection: 'notificationCaps', field: 'updatedAt', kind: 'timestamp', maxAgeMs: 2 * YEAR_MS },
  { collection: 'purgeLog', field: 'purgedAt', kind: 'timestamp', maxAgeMs: 2 * YEAR_MS },
]

export function cutoffMs(entry: RetentionEntry, now: number): number {
  return now - entry.maxAgeMs
}

// The cutoff in the field's own type (a range query only matches that type).
export function cutoffValue(kind: Kind, cutoff: number): Timestamp | number {
  return kind === 'timestamp' ? Timestamp.fromMillis(cutoff) : cutoff
}

// A field's value in millis, or null if it isn't of the entry's type.
export function dateOf(d: DocumentData, f: DateField): number | null {
  const v: unknown = d[f.field]
  if (f.kind === 'timestamp') return v instanceof Timestamp ? v.toMillis() : null
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// Past the cutoff on every date the doc carries (and it carries one).
export function isDue(entry: RetentionEntry, d: DocumentData, cutoff: number): boolean {
  const dates = [entry, ...(entry.alt ? [entry.alt] : [])].map((f) => dateOf(d, f)).filter((t): t is number => t !== null)
  return dates.length > 0 && dates.every((t) => t < cutoff)
}

// A report stays while it's open (anything but actioned/cleared, as
// reports.ts reads status), under a legal hold, or its evidence is still in
// the locker (which has its own retention and appeal pause).
export function reportProtected(r: DocumentData, inLocker: boolean): boolean {
  const resolved = r.status === 'actioned' || r.status === 'cleared'
  return !resolved || !!r.legalHold || inLocker
}

export interface PurgeResult {
  total: number
  older: number
  deleted?: number
  wouldDelete?: number
  skippedUndated: number
  skippedProtected: number
}

const db = () => getFirestore()

async function protectedIds(entry: RetentionEntry, docs: QueryDocumentSnapshot[], lockers: () => Promise<Set<string>>): Promise<Set<string>> {
  const out = new Set<string>()
  if (entry.protect === 'report') {
    const held = await lockers()
    for (const d of docs) if (reportProtected(d.data(), held.has(d.id))) out.add(d.id)
  } else if (entry.protect === 'block') {
    const pair = (d: QueryDocumentSnapshot) => [d.get('blockerUid'), d.get('blockedUid')] as unknown[]
    const mirrored = docs.filter((d) => pair(d).every((u) => typeof u === 'string' && u && !u.includes('/')))
    const mirrors = mirrored.length ? await db().getAll(...mirrored.map((d) => db().doc(`users/${d.get('blockerUid')}/blockedUsers/${d.get('blockedUid')}`))) : []
    const has = new Set(mirrored.filter((_, i) => mirrors[i].exists).map((d) => d.id))
    for (const d of docs) if (!has.has(d.id)) out.add(d.id)
  }
  return out
}

// Pages through the docs past the cutoff (per date field), deleting the due
// unprotected ones — or, in a dry run, only counting them.
export async function purgeCollection(entry: RetentionEntry, now: number, opts: { dryRun: boolean }): Promise<PurgeResult> {
  const coll = db().collection(entry.collection)
  const cutoff = cutoffMs(entry, now)
  const fields = [entry, ...(entry.alt ? [entry.alt] : [])]
  const count = async (q: Query) => (await q.count().get()).data().count
  const total = await count(coll)
  // Dated: has the field in its type, either side of the cutoff. Exact while
  // no doc carries both fields (true for reviewQueue's writers).
  let dated = 0
  for (const f of fields) {
    const v = cutoffValue(f.kind, cutoff)
    dated += (await count(coll.where(f.field, '<', v))) + (await count(coll.where(f.field, '>=', v)))
  }
  let lockerSet: Set<string> | null = null
  const lockers = async () => (lockerSet ??= new Set((await db().collection('evidenceLocker').select('reportId').get()).docs.map((d) => String(d.get('reportId')))))
  const seen = new Set<string>()
  let older = 0
  let removed = 0
  let skippedProtected = 0
  for (const f of fields) {
    const base = coll.where(f.field, '<', cutoffValue(f.kind, cutoff)).orderBy(f.field).limit(PAGE)
    let last: QueryDocumentSnapshot | null = null
    for (;;) {
      const page: QuerySnapshot = await (last ? base.startAfter(last) : base).get()
      if (page.empty) break
      last = page.docs[page.docs.length - 1]
      const fresh = page.docs.filter((d) => !seen.has(d.id))
      fresh.forEach((d) => seen.add(d.id))
      older += fresh.length
      const due = fresh.filter((d) => isDue(entry, d.data(), cutoff))
      const keep = await protectedIds(entry, due, lockers)
      const go = due.filter((d) => !keep.has(d.id))
      skippedProtected += keep.size
      if (!opts.dryRun && go.length) {
        const batch = db().batch()
        go.forEach((d) => batch.delete(d.ref))
        await batch.commit()
      }
      removed += go.length
      if (page.size < PAGE) break
    }
  }
  return {
    total,
    older,
    ...(opts.dryRun ? { wouldDelete: removed } : { deleted: removed }),
    skippedUndated: Math.max(0, total - dated),
    skippedProtected,
  }
}

export async function runRetention(now: number, dryRun: boolean): Promise<Record<string, PurgeResult>> {
  const out: Record<string, PurgeResult> = {}
  for (const entry of RETENTION) out[entry.collection] = await purgeCollection(entry, now, { dryRun })
  return out
}

// Nightly. Dry run until config/retention.enabled is true.
export const purgeRetention = onSchedule(
  { schedule: '40 3 * * *', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const dryRun = (await db().doc('config/retention').get()).data()?.enabled !== true
    const counts = await runRetention(Date.now(), dryRun)
    logger.info('purgeRetention', { dryRun, counts })
  },
)
