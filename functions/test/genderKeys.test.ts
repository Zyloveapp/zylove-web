// H2 (fresh-eyes review): one gender normaliser, read the same way by
// identity Elite, the founding circle, Explore, scoring and the public line.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { GENDER_KEYS, isGenderKey, normalizeGender } from '../src/gender'
import { categoriesOf, eliteByMatching } from '../src/identity'
import { bucketFor } from '../src/founders'
import { genderKey } from '../src/genderLine'
import { hasEliteIdentity } from '../src/trial'
import { attractionCompatibility } from '../src/legacy/tier1/scorePair'
import { attractionCompatibility as legacyAttraction } from '../src/legacy/scoring'

test('every app key is its own key', () => {
  for (const k of GENDER_KEYS) {
    assert.equal(normalizeGender(k), k)
    assert.ok(isGenderKey(k))
  }
})

test('older and odd spellings → their key', () => {
  const cases: [unknown, string][] = [
    ['Woman', 'woman'],
    [' woman', 'woman'],
    ['WOMAN ', 'woman'],
    ['cis woman', 'woman'],
    ['Cis-Woman', 'woman'],
    ['cisgender woman', 'woman'],
    ['cis man', 'man'],
    ['Man', 'man'],
    ['non_binary', 'nonbinary'],
    ['Non-binary', 'nonbinary'],
    ['non binary', 'nonbinary'],
    ['Trans Woman', 'trans_woman'],
    ['trans-woman', 'trans_woman'],
    ['transwoman', 'trans_woman'],
    ['Trans man', 'trans_man'],
    ['self_described', 'self_describe'],
    ['Self-describe', 'self_describe'],
    ['Genderfluid', 'genderfluid'],
    ['Agender', 'agender'],
    // Mobile-only options: off-map, matched by matchableAs.
    ['prefer_not_to_say', 'self_describe'],
    ['Genderqueer', 'self_describe'],
    ['Two-spirit', 'self_describe'],
    ['Intersex', 'self_describe'],
    // Lists (older mobile Play builds): the first entry.
    [['Woman'], 'woman'],
    [['trans_woman', 'man'], 'trans_woman'],
    [['Man', 'Woman'], 'man'],
    // Full-width letters fold (NFKC).
    ['ｗｏｍａｎ', 'woman'],
  ]
  for (const [raw, key] of cases) assert.equal(normalizeGender(raw), key, JSON.stringify(raw))
})

test('garbage → null', () => {
  for (const raw of [undefined, null, '', '   ', 'female', 'w0man', 'woman​', 'womanly', 'men', 'women', 42, true, {}, [], [42], ['?'], 'man; woman'])
    assert.equal(normalizeGender(raw), null, JSON.stringify(raw))
  assert.ok(!isGenderKey('Woman'))
  assert.ok(!isGenderKey(['woman']))
})

// The attack: a man stores a spelling of "woman", matchableAs men, he/him.
// Before, identity.ts gave lifetime Elite and a women's founder spot while
// Explore (case-sensitive) matched the account as a man.
test('one reading: identity Elite, founders, Explore, scoring and the line agree', () => {
  for (const g of ['Woman', 'cis woman', ' woman', ['Woman'], 'non_binary', 'Non-binary']) {
    const cats = categoriesOf(g, ['men'])
    assert.notDeepEqual(cats, ['men'], JSON.stringify(g))
    // Elite and the women's half follow the same categories Explore uses.
    assert.equal(eliteByMatching(g, ['men']), true)
    assert.equal(bucketFor(g, ['men']), 'women')
    assert.equal(hasEliteIdentity({ genderIdentity: g, matchableAs: ['men'] }), true)
    assert.ok(genderKey(g) === 'woman' || genderKey(g) === 'nonbinary')
  }
  // Scoring reads it the same way: a woman for someone attracted to women,
  // never a man for someone attracted to men.
  const seeker = (attractedTo: string[]) => ({ genderIdentity: 'man', attractedTo })
  for (const fn of [attractionCompatibility, legacyAttraction]) {
    assert.equal(fn(seeker(['women']), { genderIdentity: 'Woman', attractedTo: ['men'] }), 1)
    assert.equal(fn(seeker(['men']), { genderIdentity: 'Woman', attractedTo: ['men'] }), 0)
    assert.equal(fn(seeker(['women']), { genderIdentity: ['cis woman'], attractedTo: ['men'] }), 1)
    // Garbage: nobody's men or women (only "everyone").
    assert.equal(fn(seeker(['men']), { genderIdentity: 'female', attractedTo: ['men'] }), 0)
    assert.equal(fn(seeker(['women']), { genderIdentity: 'female', attractedTo: ['men'] }), 0)
    assert.equal(fn(seeker(['everyone']), { genderIdentity: 'female', attractedTo: ['men'] }), 1)
    // Off-map: by matchableAs.
    assert.equal(fn(seeker(['women']), { genderIdentity: 'Two-spirit', matchableAs: ['women'], attractedTo: ['men'] }), 1)
  }
})

test('a man is never identity Elite or a women\'s founder, however spelled', () => {
  for (const g of ['man', 'Man', ' MAN', 'cis man', ['Man'], 'trans_man', 'Trans Man']) {
    assert.deepEqual(categoriesOf(g, ['women']), ['men'])
    assert.equal(eliteByMatching(g, ['women']), false)
    assert.equal(bucketFor(g, ['women']), 'men')
  }
  // No key: matched by matchableAs everywhere (Explore too), so Elite only if
  // they're matched as women / nonbinary people.
  assert.deepEqual(categoriesOf('female', ['men']), ['men'])
  assert.equal(eliteByMatching('female', ['men']), false)
  assert.equal(eliteByMatching('female', ['women']), true)
  assert.deepEqual(categoriesOf('female', ['women']), ['women'])
})
