// A pair created by a like (onLike) carries engine v2 fields.
import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, db, callAs, sortedPair } from './helpers.mjs'

test.beforeEach(resetEmulators)

test('onLike: new pair has engineVersion 2, sparkEnoughInfo and a uid-keyed Deep Fit', async () => {
  const a = await seedUser('Lou', { subscriptionTier: 'elite' })
  const b = await seedUser('Mae', { genderIdentity: 'woman', attractedTo: ['men'] })
  const id = sortedPair(a.uid, b.uid)
  // onLike straight away (no onTap first), so onLike itself creates the pair.
  expect((await db.doc(`pairs/${id}`).get()).exists).toBe(false)
  await callAs(a.uid, 'onLike', { likedUserId: b.uid, mode: 'spark' })
  const pair = (await db.doc(`pairs/${id}`).get()).data()
  expect(pair.engineVersion).toBe(2)
  expect(typeof pair.sparkEnoughInfo).toBe('boolean')
  expect(pair.sparkScore).toBeGreaterThanOrEqual(0)
  expect(pair.sparkScore).toBeLessThanOrEqual(100)
  const deep = (await db.doc(`pairs/${id}/modes/deep`).get()).data()?.tier1Spark
  expect(deep).toBeTruthy()
  expect(Object.keys(deep.fitFor).sort()).toEqual([a.uid, b.uid].sort())
})
