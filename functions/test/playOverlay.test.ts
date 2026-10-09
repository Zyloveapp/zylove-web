// F-099: the Play profile can't override the rate-limited matching fields or
// the identity-locked ones in Play scoring (legacy/onProfileWrite.ts).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PLAY_OVERLAY_EXCLUDED, playOverlay } from '../src/legacy/onProfileWrite'

test('playOverlay keeps Play fields and drops matching and identity fields', () => {
  const play = {
    playDisplayName: 'Velvet', spiceLevel: 'warm', playInterestTags: ['x'], ageMin: 25, ageMax: 40,
    religion: 'christian', politicalView: 'liberal', drinkingHabit: 'regularly', attractedTo: ['women'],
    dealbreakers: ['different_religion'], intent: 'play', genderIdentity: 'woman', genderSelfDescribe: 'x',
    matchableAs: ['women'], age: 19, birthday: '2000-01-01',
  }
  const out = playOverlay(play)
  for (const k of PLAY_OVERLAY_EXCLUDED) assert.equal(k in out, false, k)
  assert.deepEqual(out, { playDisplayName: 'Velvet', spiceLevel: 'warm', playInterestTags: ['x'], ageMin: 25, ageMax: 40 })
  // The input isn't changed.
  assert.equal(play.religion, 'christian')
})
