// H8 (fresh-eyes review 2026-10-09): a user's pairs are re-scored at most
// once per window; a change inside it is owed (rescoreDueAt) and the sweep
// re-scores it — so a burst of writes costs one re-score now and one later.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { RESCORE_LEASE_MS, RESCORE_WINDOW_MS, decideRescore } from '../src/rescoreDebounce'

const MIN = 60 * 1000
const T = 1_800_000_000_000

test('the window is 10 minutes, the lease longer than any run', () => {
  assert.equal(RESCORE_WINDOW_MS, 10 * MIN)
  assert.ok(RESCORE_LEASE_MS > 540 * 1000)
})

test('first change, or one after the window: run now', () => {
  assert.deepEqual(decideRescore({}, T, RESCORE_WINDOW_MS), { run: true })
  assert.deepEqual(decideRescore({ rescoreLastRunAt: T - 10 * MIN }, T, RESCORE_WINDOW_MS), { run: true })
  assert.deepEqual(decideRescore({ rescoreLastRunAt: 'junk' }, T, RESCORE_WINDOW_MS), { run: true })
})

test('a change inside the window is owed at the window\'s end (an earlier due time stands)', () => {
  assert.deepEqual(decideRescore({ rescoreLastRunAt: T - 3 * MIN }, T, RESCORE_WINDOW_MS), { run: false, dueAt: T + 7 * MIN })
  // A run in progress holds a lease further out: the change owes the window's end.
  assert.deepEqual(decideRescore({ rescoreLastRunAt: T - MIN, rescoreDueAt: T - MIN + RESCORE_LEASE_MS }, T, RESCORE_WINDOW_MS), { run: false, dueAt: T + 9 * MIN })
  assert.deepEqual(decideRescore({ rescoreLastRunAt: T - 3 * MIN, rescoreDueAt: T + MIN }, T, RESCORE_WINDOW_MS), { run: false, dueAt: T + MIN })
})

test('a burst of 50 writes in a minute: one run now, one owed — and the owed one comes after the last write', () => {
  // Simulates the state the transactions keep, the sweep running every 5
  // minutes from T.
  const state: { rescoreLastRunAt?: number; rescoreDueAt?: number } = {}
  let runs = 0
  const lastWrite = T + 49 * 1200
  for (let i = 0; i < 50; i++) {
    const now = T + i * 1200
    const d = decideRescore(state, now, RESCORE_WINDOW_MS)
    if (d.run) {
      runs++
      state.rescoreLastRunAt = now
      delete state.rescoreDueAt // the run finished (lease cleared)
    } else state.rescoreDueAt = d.dueAt
  }
  assert.equal(runs, 1)
  assert.equal(state.rescoreDueAt, T + RESCORE_WINDOW_MS)
  let swept: number | null = null
  for (let s = T; s <= T + 30 * MIN; s += 5 * MIN) {
    if (state.rescoreDueAt !== undefined && state.rescoreDueAt <= s) {
      swept = s
      break
    }
  }
  assert.ok(swept !== null && swept > lastWrite && swept <= T + RESCORE_WINDOW_MS + 5 * MIN)
})

test('window 0 (the emulator unless a test opts in): every change runs', () => {
  assert.deepEqual(decideRescore({ rescoreLastRunAt: T }, T, 0), { run: true })
})
