// T&S Phase 2 — scam-report independence, signup country, the reply band,
// the new risk reasons and the GeoLite archive reader.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { gzipSync, gunzipSync } from 'node:zlib'
import { FLAG_AT, featuresOf, replyBandOf, scoreFeatures, type Features } from '../src/trustScore'
import { REPORTER_MIN_AGE_MS, independentReporters } from '../src/scamReports'
import { countryDisagreement, countryOfCity, countryOfPhone, mmdbFromTar } from '../src/geo'
import { isAiPhoto, isStolenPhoto } from '../src/photoChecks'

const DAY = 864e5
const now = Date.now()
const base = (o: Partial<Features> = {}): Features => ({
  ...featuresOf({ root: { photoURLs: ['a'] }, internal: { accountCreatedAt: now - 60 * DAY }, signals: {} }),
  ...o,
})

test('scam reports: reporters must be 48h+ old and not linked to each other', () => {
  const created = new Map([
    ['a', now - 10 * DAY],
    ['b', now - 10 * DAY],
    ['c', now - REPORTER_MIN_AGE_MS + 60_000], // a day and change old: too new
  ])
  const none = new Map<string, Set<string>>()
  assert.deepEqual(independentReporters(['a', 'b'], created, none, now), ['a', 'b'])
  assert.deepEqual(independentReporters(['a', 'c'], created, none, now), ['a'])
  // Linked (either direction) counts once.
  assert.deepEqual(independentReporters(['a', 'b'], created, new Map([['a', new Set(['b'])]]), now), ['a'])
  assert.deepEqual(independentReporters(['a', 'b'], created, new Map([['b', new Set(['a'])]]), now), ['a'])
  // Unknown age never counts.
  assert.deepEqual(independentReporters(['a', 'x'], created, none, now), ['a'])
})

test('signup country: any two known countries that disagree; unknowns ignored', () => {
  assert.equal(countryDisagreement({ ip: 'US', phone: 'US', city: 'US' }), null)
  assert.equal(countryDisagreement({ ip: null, phone: 'US', city: 'US' }), null)
  assert.equal(countryDisagreement({ ip: null, phone: null, city: 'US' }), null)
  assert.equal(countryDisagreement({ ip: 'NG', phone: 'US', city: 'US' }), 'IP: NG · phone: US · city: US')
  assert.equal(countryDisagreement({ ip: null, phone: 'GB', city: 'US' }), 'phone: GB · city: US')
})

test('phone and city countries', () => {
  assert.equal(countryOfPhone('+447700900123'), 'GB')
  assert.equal(countryOfPhone('+15125550134'), 'US')
  assert.equal(countryOfPhone('+15550000001'), 'US') // unassigned NANP area code
  assert.equal(countryOfPhone(null), null)
  assert.equal(countryOfCity('austin'), 'US')
  assert.equal(countryOfCity('atlantis'), null)
})

test('GeoLite archive: the .mmdb comes out of the tar', () => {
  const header = (name: string, size: number) => {
    const h = Buffer.alloc(512)
    h.write(name, 0)
    h.write(size.toString(8).padStart(11, '0') + '\0', 124)
    h.write('0', 156)
    return h
  }
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)])
  const readme = Buffer.from('hello')
  const db = Buffer.from('MMDB-BYTES-0123456789')
  const tar = Buffer.concat([header('GeoLite2-Country_20261007/README.txt', readme.length), pad(readme), header('GeoLite2-Country_20261007/GeoLite2-Country.mmdb', db.length), pad(db), Buffer.alloc(1024)])
  assert.deepEqual(mmdbFromTar(gunzipSync(gzipSync(tar))), db)
  assert.equal(mmdbFromTar(Buffer.concat([header('x/README', 5), pad(readme), Buffer.alloc(1024)])), null)
})

test('reply band: only after 5+ conversations started by others, only "usually"', () => {
  assert.equal(replyBandOf({ conversationsReceived: 4, repliesGiven: 4 }), null)
  assert.equal(replyBandOf({ conversationsReceived: 5, repliesGiven: 4 }), 'usually')
  assert.equal(replyBandOf({ conversationsReceived: 10, repliesGiven: 6 }), null)
})

test('anti-scam reasons: each strong signal flags on its own, with a plain reason', () => {
  const cases: [Partial<Features>, string, RegExp][] = [
    [{ scamTrapHits: 1, scamTrapKinds: ['moneyRequest'] }, 'scam_trap', /curated profile \(asked for money\)/],
    [{ scamReporters30d: 2 }, 'scam_reports', /scam by 2 people/],
    [{ aiPhotos: 1 }, 'ai_photo', /AI-generated/],
    [{ stolenPhotos: 2 }, 'stolen_photo', /2 photos appear elsewhere/],
    [{ countryMismatch: 'IP: NG · phone: US · city: US' }, 'country_mismatch', /Signup countries disagree/],
  ]
  for (const [f, key, text] of cases) {
    const r = scoreFeatures(base(f), null)
    assert.ok(r.score >= FLAG_AT, key)
    assert.equal(r.reasons[0].key, key)
    assert.match(r.reasons[0].text, text)
  }
  // One scam report alone doesn't flag.
  assert.ok(scoreFeatures(base({ scamReporters30d: 1 }), null).score < FLAG_AT)
})

test('features read the new signals', () => {
  const f = featuresOf({
    signals: { scamTrap: { count: 2, hits: ['code'] }, photoFlags: { ai: 1, stolen: 0 }, countryMismatch: { text: 'phone: GB · city: US' } },
  })
  assert.equal(f.scamTrapHits, 2)
  assert.deepEqual(f.scamTrapKinds, ['code'])
  assert.equal(f.aiPhotos, 1)
  assert.equal(f.countryMismatch, 'phone: GB · city: US')
})

test('photo thresholds', () => {
  assert.ok(isAiPhoto({ ai: 0.95, deepfake: null }))
  assert.ok(isAiPhoto({ ai: 0.1, deepfake: 0.85 }))
  assert.ok(!isAiPhoto({ ai: 0.5, deepfake: 0.5 }))
  assert.ok(isStolenPhoto({ web: { full: 1, pages: 0, sample: [] } }))
  assert.ok(!isStolenPhoto({ web: { full: 0, pages: 0, sample: [] } }))
  assert.ok(!isStolenPhoto({ web: null }))
})
