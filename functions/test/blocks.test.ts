// Review 2026-10-09: C1 (a block belongs to whoever placed it), H3 (a block
// you placed holds in its own mode only; one placed on you, in both) and H5
// (a blocked chat kept for both for the report window, then the blocker's).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { afterLift, blockApplies, blockedFor, blockModes, hiddenInMode, planBlock, preservedExpiry } from '../src/blockCore'

test('blockModes: modes, else the single mode, else every mode (null)', () => {
  assert.deepEqual(blockModes({ blockedBy: 'v', modes: ['spark', 'play'], mode: 'spark' }), ['spark', 'play'])
  assert.deepEqual(blockModes({ blockedBy: 'v', mode: 'play' }), ['play'])
  assert.deepEqual(blockModes({ blockedBy: 'v', modes: ['play', 'play', 'x'] }), ['play'])
  // Older records (no mode), mobile's, junk: every mode.
  assert.equal(blockModes({ blockedBy: 'v' }), null)
  assert.equal(blockModes({ blockedBy: 'v', modes: [] }), null)
  assert.equal(blockModes({ mode: 'both' }), null)
  assert.deepEqual(blockModes(undefined), [])
})

test('H3: a block you placed changes only its own mode; one placed on you, both', () => {
  const sparkByV = { blockedBy: 'v', mode: 'spark', modes: ['spark'] }
  assert.equal(blockApplies('v', sparkByV, 'spark'), true)
  assert.equal(blockApplies('v', sparkByV, 'play'), false)
  // The person blocked: unavailable to them everywhere.
  assert.equal(blockApplies('a', sparkByV, 'spark'), true)
  assert.equal(blockApplies('a', sparkByV, 'play'), true)
  // Both modes.
  const both = { blockedBy: 'v', modes: ['spark', 'play'] }
  assert.equal(blockApplies('v', both, 'play'), true)
  // Older records without a mode, or without a blocker: both modes, for everyone.
  assert.equal(blockApplies('v', { blockedBy: 'v' }, 'play'), true)
  assert.equal(blockApplies('v', { blockedAt: 7 } as never, 'play'), true)
  assert.equal(blockApplies('v', undefined, 'spark'), false)
  // Either mirror record counts.
  assert.equal(blockedFor('v', [undefined, sparkByV], 'play'), false)
  assert.equal(blockedFor('a', [undefined, sparkByV], 'play'), true)
  assert.equal(blockedFor('v', [undefined, undefined], 'spark'), false)
})

test('C1: blocking over someone else\'s block is a no-op; your own is created, extended or already there', () => {
  assert.equal(planBlock('v', [undefined, undefined], 'spark'), 'create')
  // The person blocked blocks back: nothing changes.
  const byV = { blockedBy: 'v', mode: 'spark', modes: ['spark'] }
  assert.equal(planBlock('a', [byV, byV], 'spark'), 'noop')
  assert.equal(planBlock('a', [byV, byV], 'play'), 'noop')
  assert.equal(planBlock('a', [undefined, byV], 'spark'), 'noop')
  // A record with no blocker recorded (mobile's) is never taken over either.
  assert.equal(planBlock('a', [{}, undefined], 'spark'), 'noop')
  // Your own block again: same mode, or the other one too.
  assert.equal(planBlock('v', [byV, byV], 'spark'), 'same')
  assert.equal(planBlock('v', [byV, byV], 'play'), 'extend')
  assert.equal(planBlock('v', [byV, undefined], 'play'), 'extend')
  assert.equal(planBlock('v', [{ blockedBy: 'v' }, { blockedBy: 'v' }], 'play'), 'same') // already every mode
})

test('lifting: one mode of a two-mode block leaves the other; the last one deletes', () => {
  assert.deepEqual(afterLift({ blockedBy: 'v', modes: ['spark', 'play'] }, 'spark'), ['play'])
  assert.equal(afterLift({ blockedBy: 'v', modes: ['play'] }, 'play'), 'delete')
  assert.equal(afterLift({ blockedBy: 'v', mode: 'spark' }, 'spark'), 'delete')
  assert.equal(afterLift({ blockedBy: 'v' }, 'spark'), 'delete')
})

test('Explore: hidden in a mode = blocks placed on you plus your own in that mode', () => {
  const state = { blocked: ['x'], spark: { blocked: ['s'], acted: ['q'] }, play: { blocked: ['p'] } }
  assert.deepEqual(hiddenInMode(state, 'spark'), ['x', 's'])
  assert.deepEqual(hiddenInMode(state, 'play'), ['x', 'p'])
  assert.deepEqual(hiddenInMode(undefined, 'play'), [])
  assert.deepEqual(hiddenInMode({ blocked: 'nope' as never }, 'play'), [])
})

test('H5: a kept chat past its window — still only blocked: back to the blocker; unmatched or not blocked: deleted', () => {
  assert.equal(preservedExpiry({ isBlocked: true }), 'release')
  assert.equal(preservedExpiry({ isBlocked: true, unmatchedAt: null }), 'release')
  assert.equal(preservedExpiry({ isBlocked: true, unmatchedAt: { seconds: 1 } }), 'delete')
  assert.equal(preservedExpiry({ unmatchedAt: { seconds: 1 } }), 'delete')
  assert.equal(preservedExpiry(undefined), 'delete')
})
