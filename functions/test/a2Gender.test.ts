// §4.A2: the public genderLine (every case, and the sanitising of the free
// text that goes on the public doc), and F-098: "Trans men" / "Trans women"
// attraction counts as men / women in both scoring copies and Explore.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildGenderLine, cleanPronouns, cleanSelfDescribe, genderKey, MAX_PRONOUNS, MAX_SELF_DESCRIBE } from '../src/genderLine'
import { attractionCompatibility as sparkAttraction } from '../src/legacy/scoring'
import { attractionCompatibility as tier1Attraction } from '../src/legacy/tier1/scorePair'
import { foldAttraction, sparkCardProfile } from '../src/explore'

test('man / woman: nothing by default, the gender when they chose to show it', () => {
  assert.equal(buildGenderLine({ genderIdentity: 'man' }), '')
  assert.equal(buildGenderLine({ genderIdentity: 'woman', showGender: false }), '')
  assert.equal(buildGenderLine({ genderIdentity: 'man', showGender: true }), 'Man')
  assert.equal(buildGenderLine({ genderIdentity: 'woman', showGender: true, pronouns: 'she/her' }), 'Woman · she/her')
  // only true counts
  assert.equal(buildGenderLine({ genderIdentity: 'woman', showGender: 'yes' }), '')
})

test('man / woman not shown: pronouns alone', () => {
  assert.equal(buildGenderLine({ genderIdentity: 'woman', pronouns: 'she/her' }), 'she/her')
  assert.equal(buildGenderLine({ genderIdentity: 'man', pronouns: ' he / him ' }), 'he / him')
})

test('trans, non-binary and the other listed identities: the label, then pronouns', () => {
  assert.equal(buildGenderLine({ genderIdentity: 'trans_woman', pronouns: 'she/her' }), 'Trans woman · she/her')
  assert.equal(buildGenderLine({ genderIdentity: 'trans_man' }), 'Trans man')
  assert.equal(buildGenderLine({ genderIdentity: 'nonbinary', pronouns: 'they/them' }), 'Non-binary · they/them')
  assert.equal(buildGenderLine({ genderIdentity: 'genderfluid' }), 'Genderfluid')
  assert.equal(buildGenderLine({ genderIdentity: 'agender', pronouns: 'any' }), 'Agender · any')
  // showGender changes nothing for them
  assert.equal(buildGenderLine({ genderIdentity: 'trans_man', showGender: true }), 'Trans man')
})

test('older stored forms: arrays (mobile Play), labels, hyphens', () => {
  assert.equal(genderKey(['trans_woman', 'woman']), 'trans_woman')
  assert.equal(genderKey('Trans Woman'), 'trans_woman')
  assert.equal(genderKey('non-binary'), 'nonbinary')
  assert.equal(genderKey('non_binary'), 'nonbinary')
  assert.equal(buildGenderLine({ genderIdentity: ['nonbinary'] }), 'Non-binary')
  assert.equal(buildGenderLine({ genderIdentity: 'Non-Binary' }), 'Non-binary')
})

test('self-describe: their words (sanitised), then pronouns; none given, pronouns only', () => {
  assert.equal(buildGenderLine({ genderIdentity: 'self_describe', genderSelfDescribe: 'Two-spirit', pronouns: 'they/them' }), 'Two-spirit · they/them')
  assert.equal(buildGenderLine({ genderIdentity: 'self_describe', genderSelfDescribe: '   ', pronouns: 'xe/xem' }), 'xe/xem')
  assert.equal(buildGenderLine({ genderIdentity: 'self_describe' }), '')
  // the text isn't used for any other identity
  assert.equal(buildGenderLine({ genderIdentity: 'woman', genderSelfDescribe: 'Femme', showGender: true }), 'Woman')
  // any language
  assert.equal(buildGenderLine({ genderIdentity: 'self_describe', genderSelfDescribe: 'Māhū' }), 'Māhū')
})

test('hidden: nothing at all — gender and pronouns', () => {
  assert.equal(buildGenderLine({ genderIdentity: 'trans_woman', pronouns: 'she/her', genderHidden: true }), '')
  assert.equal(buildGenderLine({ genderIdentity: 'self_describe', genderSelfDescribe: 'Demigirl', genderHidden: true }), '')
  assert.equal(buildGenderLine({ genderIdentity: 'woman', showGender: true, genderHidden: true }), '')
})

test('empty or garbage input: empty, or pronouns only', () => {
  assert.equal(buildGenderLine(undefined), '')
  assert.equal(buildGenderLine(null), '')
  assert.equal(buildGenderLine({}), '')
  assert.equal(buildGenderLine({ genderIdentity: 42 }), '')
  assert.equal(buildGenderLine({ genderIdentity: '<script>alert(1)</script>' }), '')
  assert.equal(buildGenderLine({ genderIdentity: { a: 1 }, pronouns: 'she/her' }), 'she/her')
  assert.equal(buildGenderLine({ genderIdentity: 'nonbinary', pronouns: 12 }), 'Non-binary')
  assert.equal(buildGenderLine({ genderIdentity: [] }), '')
})

test('free text on the public doc: no digits, links, handles, separators or control characters; capped', () => {
  assert.equal(cleanSelfDescribe('call 555 123 4567'), 'call')
  assert.equal(cleanSelfDescribe('see zylove.example.com'), 'see zyloveexamplecom')
  assert.equal(cleanSelfDescribe('https://x.co/@me'), 'https//xco/me')
  assert.equal(cleanSelfDescribe('Femme · Trans woman'), 'Femme Trans woman')
  assert.equal(cleanSelfDescribe('a\u0000b​c‮d'), 'abcd')
  assert.equal(cleanSelfDescribe('  two \n\t spirit  '), 'two spirit')
  assert.equal(cleanSelfDescribe('Genderqueer (mostly), butch & proud'), 'Genderqueer (mostly), butch & proud')
  assert.equal(cleanSelfDescribe('🌈 queer 🌈'), 'queer')
  assert.equal(cleanSelfDescribe(null), '')
  const long = cleanSelfDescribe('x'.repeat(200))
  assert.equal(long.length, MAX_SELF_DESCRIBE)
  assert.equal(cleanPronouns('she/her (ask me!) 123'), 'she/her ask me')
  assert.equal(cleanPronouns('they/them · @insta'), 'they/them insta')
  assert.equal(cleanPronouns('y'.repeat(100)).length, MAX_PRONOUNS)
  // the line itself never carries more than one separator
  const line = buildGenderLine({ genderIdentity: 'self_describe', genderSelfDescribe: 'a · b · c', pronouns: 'd · e' })
  assert.equal(line.split(' · ').length, 2)
})

const person = (genderIdentity: unknown, attractedTo: string[], matchableAs?: string[]) => ({ genderIdentity, attractedTo, matchableAs })

test('F-098: "Trans women" attraction scores cis and trans women alike (both scoring copies)', () => {
  for (const attraction of [sparkAttraction, tier1Attraction]) {
    const seeker = person('man', ['trans_women'])
    assert.equal(attraction(seeker, person('woman', ['men'])), 1)
    assert.equal(attraction(seeker, person('trans_woman', ['men'])), 1)
    assert.equal(attraction(seeker, person('man', ['men'])), 0)
    const seeker2 = person('woman', ['trans_men'])
    assert.equal(attraction(seeker2, person('man', ['women'])), 1)
    assert.equal(attraction(seeker2, person('trans_man', ['women'])), 1)
    // unchanged: men / women / non-binary, and off-map identities by matchableAs
    assert.equal(attraction(person('man', ['women']), person('trans_woman', ['men'])), 1)
    assert.equal(attraction(person('man', ['women']), person('nonbinary', ['men'])), 0)
    assert.equal(attraction(person('man', ['nonbinary_people']), person('nonbinary', ['men'])), 1)
    assert.equal(attraction(person('man', ['women']), person('agender', ['men'], ['trans_women'])), 1)
    assert.equal(attraction(person('man', ['trans_women']), person('agender', ['men'], ['women'])), 1)
  }
})

test('F-098: Explore folds the same way', () => {
  assert.deepEqual(foldAttraction(['trans_women', 'men', 'trans_men', 'everyone']), ['women', 'men', 'men', 'everyone'])
  assert.deepEqual(foldAttraction('trans_women'), ['women'])
  assert.deepEqual(foldAttraction(undefined), [])
})

test('§4.A2: Explore cards never carry the gender fields, only the line', () => {
  const card = sparkCardProfile({
    displayName: 'X', genderIdentity: 'trans_woman', genderSelfDescribe: 'x', pronouns: 'she/her', genderHidden: false, showGender: true,
    genderLine: 'Trans woman · she/her', religion: 'jewish', politicalView: 'liberal',
  })
  assert.deepEqual(card, { displayName: 'X', genderLine: 'Trans woman · she/her' })
})
