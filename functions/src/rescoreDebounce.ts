import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { logId } from './logSafe'

// H8 (fresh-eyes review 2026-10-09): a profile change re-scores every pair
// of the user (legacy/onProfileWrite.ts), so a client looping writes
// (private/matching's age range, any scored field) kept the scoring
// functions busy for everyone. A user's pairs are now re-scored at most once
// per RESCORE_WINDOW_MS: the first change runs at once; changes inside the
// window leave a due time, and sweepRescores (every 5 minutes) re-scores
// those users from their docs as they are then — so the final state is
// always scored, at most window + sweep interval late.
//
// State in rateLimits/{uid} (server-only; dropped with the account, and no
// triggers, unlike userInternal):
//   rescoreLastRunAt  when the last re-score started (ms)
//   rescoreDueAt      ms; present while a re-score is owed — a change inside
//                     the window, or the lease of a run in progress (cleared
//                     when it finishes, so a run that dies is retried)

export const RESCORE_WINDOW_MS = 10 * 60 * 1000
// Longer than any run (triggers time out at 60 s, the sweep at 540 s).
export const RESCORE_LEASE_MS = 15 * 60 * 1000
const SWEEP_LIMIT = 100
const SWEEP_PARALLEL = 5

interface RescoreState {
  rescoreLastRunAt?: unknown
  rescoreDueAt?: unknown
  rescoreWindowMs?: unknown
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// What a change at `now` does: run now (outside the window since the last
// run), or owe a run at the window's end — or earlier, if one is owed already.
export function decideRescore(state: RescoreState, now: number, windowMs: number): { run: true } | { run: false; dueAt: number } {
  const last = num(state.rescoreLastRunAt)
  if (last === null || now - last >= windowMs) return { run: true }
  const due = num(state.rescoreDueAt)
  return { run: false, dueAt: Math.min(due ?? Infinity, last + windowMs) }
}

// The emulator (e2e) re-scores at once unless a test sets rescoreWindowMs on
// the user's doc — the suite expects prompt re-scores. Never in production.
function windowFor(state: RescoreState): number {
  if (process.env.FUNCTIONS_EMULATOR === 'true') return num(state.rescoreWindowMs) ?? 0
  return RESCORE_WINDOW_MS
}

const stateRef = (uid: string) => getFirestore().doc(`rateLimits/${uid}`)

// Starts a run (its lease, which finishRescore clears) or records the owed one.
async function claim(uid: string, sweepDueBy: number | null): Promise<number | null> {
  const db = getFirestore()
  const ref = stateRef(uid)
  return db.runTransaction(async (tx) => {
    const state = ((await tx.get(ref)).data() ?? {}) as RescoreState
    const now = Date.now()
    if (sweepDueBy !== null) {
      // The sweep: only if still owed (a trigger may have run it meanwhile).
      const due = num(state.rescoreDueAt)
      if (due === null || due > sweepDueBy) return null
    } else {
      const d = decideRescore(state, now, windowFor(state))
      if (!d.run) {
        tx.set(ref, { rescoreDueAt: d.dueAt }, { merge: true })
        return null
      }
    }
    const lease = now + RESCORE_LEASE_MS
    tx.set(ref, { rescoreLastRunAt: now, rescoreDueAt: lease }, { merge: true })
    return lease
  })
}

// A finished run clears its lease — unless a change since owes another.
async function finish(uid: string, lease: number): Promise<void> {
  const db = getFirestore()
  const ref = stateRef(uid)
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (snap.exists && snap.get('rescoreDueAt') === lease) tx.update(ref, { rescoreDueAt: FieldValue.delete() })
  })
}

// For a scored change: re-scores `uid` now, or leaves it to the sweep.
export async function requestRescore(uid: string, run: (uid: string) => Promise<void>): Promise<boolean> {
  const lease = await claim(uid, null)
  if (lease === null) return false
  await run(uid)
  await finish(uid, lease)
  return true
}

// Re-scores the users whose re-score is owed by `dueBy` (now, unless a test
// flushes the window). Returns the uids re-scored.
export async function sweepPendingRescores(run: (uid: string) => Promise<void>, dueBy = Date.now()): Promise<string[]> {
  const snap = await getFirestore().collection('rateLimits').where('rescoreDueAt', '<=', dueBy).orderBy('rescoreDueAt').limit(SWEEP_LIMIT).get()
  const done: string[] = []
  for (let i = 0; i < snap.docs.length; i += SWEEP_PARALLEL) {
    await Promise.all(
      snap.docs.slice(i, i + SWEEP_PARALLEL).map(async (d) => {
        const lease = await claim(d.id, dueBy)
        if (lease === null) return
        try {
          await run(d.id)
          await finish(d.id, lease)
          done.push(d.id)
        } catch (err) {
          // The lease stays: retried once it runs out.
          logger.error('sweepRescores: re-score failed', { uid: logId(d.id), message: err instanceof Error ? err.message : String(err) })
        }
      }),
    )
  }
  return done
}
