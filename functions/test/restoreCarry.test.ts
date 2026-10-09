// H6 (fresh-eyes review): a restored account's blocks follow it to its new
// uid, both ways; reports still waiting for review stop the restore.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { rekeyBlocks, reportPending } from '../src/restoreCheck'

const OLD = 'old-uid'
const NEW = 'new-uid'
const pathsOf = (r: ReturnType<typeof rekeyBlocks>) => Object.fromEntries(r.set.map((w) => [w.path, w.data]))

test('a victim\'s block on the old uid applies to the new one, both sides', () => {
  // Vic blocked the harasser: the mirror pair.
  const r = rekeyBlocks(OLD, NEW, [
    { owner: 'vic', other: OLD, data: { uid: OLD, blockedBy: 'vic', blockedAt: 1, mode: 'spark' } },
    { owner: OLD, other: 'vic', data: { uid: 'vic', blockedBy: 'vic', blockedAt: 1, mode: 'spark' } },
  ])
  const set = pathsOf(r)
  assert.deepEqual(set[`users/vic/blockedUsers/${NEW}`], { uid: NEW, blockedBy: 'vic', blockedAt: 1, mode: 'spark' })
  assert.deepEqual(set[`users/${NEW}/blockedUsers/vic`], { uid: 'vic', blockedBy: 'vic', blockedAt: 1, mode: 'spark' })
  assert.deepEqual(r.remove.sort(), [`users/${OLD}/blockedUsers/vic`, `users/vic/blockedUsers/${OLD}`].sort())
  assert.deepEqual(r.others, ['vic'])
})

test('a block the account placed stays its own (blockedBy re-keyed)', () => {
  const r = rekeyBlocks(OLD, NEW, [
    { owner: OLD, other: 'bob', data: { uid: 'bob', blockedBy: OLD, blockedAt: 2 } },
    { owner: 'bob', other: OLD, data: { uid: OLD, blockedBy: OLD, blockedAt: 2 } },
  ])
  const set = pathsOf(r)
  assert.equal(set[`users/${NEW}/blockedUsers/bob`].blockedBy, NEW)
  assert.equal(set[`users/bob/blockedUsers/${NEW}`].blockedBy, NEW)
})

test('one side missing: rebuilt from the other; each side keeps its own fields', () => {
  // Only the victim's entry (the old account's list already gone).
  const only = pathsOf(rekeyBlocks(OLD, NEW, [{ owner: 'vic', other: OLD, data: { uid: OLD, blockedBy: 'vic', mode: 'play' } }]))
  assert.deepEqual(only[`users/${NEW}/blockedUsers/vic`], { uid: 'vic', blockedBy: 'vic', mode: 'play' })
  assert.deepEqual(only[`users/vic/blockedUsers/${NEW}`], { uid: NEW, blockedBy: 'vic', mode: 'play' })
  // Two sides that disagree: neither overwrites the other's own doc.
  const both = pathsOf(
    rekeyBlocks(OLD, NEW, [
      { owner: OLD, other: 'vic', data: { uid: 'vic', blockedBy: OLD } },
      { owner: 'vic', other: OLD, data: { uid: OLD, blockedBy: 'vic' } },
    ]),
  )
  assert.equal(both[`users/vic/blockedUsers/${NEW}`].blockedBy, 'vic')
  assert.equal(both[`users/${NEW}/blockedUsers/vic`].blockedBy, NEW)
  // Older mobile blocks with no direction stay without one.
  const legacy = pathsOf(rekeyBlocks(OLD, NEW, [{ owner: 'vic', other: OLD, data: { uid: OLD } }]))
  assert.equal('blockedBy' in legacy[`users/vic/blockedUsers/${NEW}`], false)
})

test('several people; nothing about the new uid itself or unrelated docs', () => {
  const r = rekeyBlocks(OLD, NEW, [
    { owner: 'a', other: OLD, data: { blockedBy: 'a' } },
    { owner: 'b', other: OLD, data: { blockedBy: 'b' } },
    { owner: OLD, other: NEW, data: { blockedBy: OLD } },
    { owner: 'x', other: 'y', data: { blockedBy: 'x' } },
  ])
  assert.deepEqual(r.others.sort(), ['a', 'b'])
  assert.equal(r.set.length, 4)
  assert.ok(r.set.every((w) => !w.path.includes(OLD)))
})

test('reports waiting for review stop a restore; reviewed ones don\'t', () => {
  assert.equal(reportPending({ status: 'pending' }), true)
  assert.equal(reportPending({}), true)
  assert.equal(reportPending({ status: 'actioned' }), false)
  assert.equal(reportPending({ status: 'cleared' }), false)
})
