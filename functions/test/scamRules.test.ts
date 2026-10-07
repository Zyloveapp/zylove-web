// T&S Phase 2 — scam patterns (Appendix B of the plan), links and codes.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { hasLink, looksLikeCode, scamCheck, scamExcerpt } from '../src/shared/scamRules'

const CASES: [string, boolean][] = [
  ['Can you send me the code you just got? It was sent to you by mistake', true],
  ['what is the 6 digit code they texted you', true],
  ['babe can you get me a $100 Google Play card', true],
  ['I need to borrow 300 dollars for my hospital bill', true],
  ['can you send me money through cash app', true],
  ['I make good money trading crypto, let me show you my investment platform', true],
  ["I'm rarely on here, text me on WhatsApp", true],
  ["I'm deployed overseas right now, it's urgent", true],
  ['add me on telegram, I do bitcoin mining', true],
  ['venmo me $40 for the tickets?', true], // advisory banner is acceptable
  ['what code do you write at work? python?', false],
  ['my verification badge finally came through lol', false],
  ['I got you a gift for your birthday', false],
  ['I work in crypto compliance, boring I know', false],
  ['my brother is deployed, I worry about him', false],
  ['do you use whatsapp to talk to family abroad?', false],
  ['dinner is $40 each, I can pay us back on the way', false],
  ['the cafe takes cash app and venmo', false],
  ['I hate when people ask for money on apps', false],
  ['my PIN on my phone is my dog bday haha', false],
  ['urgent: need coffee', false],
  ["I trade stocks on Robinhood, it's a hobby", false],
  ['my friend lost money to a crypto platform scam', true], // advisory banner is acceptable
  ["I'm barely on here, let's move to telegram", true],
  ['are you on signal? I use it for work', false],
]

test('scam patterns: the plan’s 25 cases', () => {
  for (const [text, want] of CASES) assert.equal(scamCheck(text).flagged, want, text)
})

test('scam patterns: ordinary "send me…" is not about money', () => {
  for (const t of ['send me a pic of your dog', 'can you send me that song?', 'send me the address later']) assert.equal(scamCheck(t).flagged, false, t)
  assert.deepEqual(scamCheck('Can you send me the code you just got?').hits, ['code'])
  for (const t of ['venmo me $40', 'can you lend me 200 bucks', 'paypal me please']) assert.ok(scamCheck(t).hits.includes('moneyRequest'), t)
})

test('scam patterns: which categories hit', () => {
  assert.deepEqual(scamCheck('what is the 6 digit code they texted you').hits, ['code'])
  assert.deepEqual(scamCheck("I'm rarely on here, text me on WhatsApp").hits.sort(), ['leavingApp', 'offPlatform'])
  assert.deepEqual(scamCheck('hello there').hits, [])
})

test('the excerpt is short and around the hit', () => {
  const long = `${'Nice to meet you. '.repeat(20)}Can you send me money for the hospital bill? ${'Thanks. '.repeat(30)}`
  const ex = scamExcerpt(long, scamCheck(long).hits)
  assert.ok(ex.length <= 200)
  assert.match(ex, /send me money/)
})

test('links: plain URLs, bare domains and messenger links; not ordinary text', () => {
  for (const t of ['check https://example.com', 'go to www.site.org now', 'janedoe.com', 'wa.me/447700900123', 't.me/someone']) assert.ok(hasLink(t), t)
  for (const t of ["let's meet at 7:30", 'I live at 4th and Congress', 'see you @ 7', 'that was so.cool lol']) assert.ok(!hasLink(t), t)
})

test('codes: a bare code or "my code is 123456"; not times, prices or ordinary numbers', () => {
  for (const t of ['482913', '4829 13', 'the code is 482913', 'OTP: 1234']) assert.ok(looksLikeCode(t), t)
  for (const t of ['7:30?', 'it was $150', 'I have 2 dogs', 'room 1205, floor 12', 'born in 1995']) assert.ok(!looksLikeCode(t), t)
})

test('the app’s copy of the rules matches the server’s', () => {
  const body = (p: string) => readFileSync(new URL(p, `file://${__dirname}/`), 'utf8').split('\n').slice(1).join('\n')
  assert.equal(body('../../../src/services/scamRules.ts'), body('../../src/shared/scamRules.ts'))
})
