// T&S Phase 3 — the contact-info detector (the plan's Appendix A cases, plus
// Snapchat / WhatsApp phrasing) and recipient-side masking.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { CONTACT_MASK, detectContact, maskContact } from '../src/shared/contactDetect'

const APPENDIX: [string, boolean][] = [
  ['call me 512-555-0134', true], ['my number is (512) 555 0134', true], ['+1 512 555 0134', true], ['5125550134', true],
  ['five one two five five five zero one three four', true], ['text me at 512.555.0134', true],
  ['jane.doe@gmail.com', true], ['jane dot doe at gmail dot com', true], ['jane(at)gmail(dot)com', true],
  ['my insta is jane.d', true], ['add me on snap', true], ['snap: jane_d22', true], ['@jane.doe23', true], ['hit me up on telegram', true],
  ['find me on IG @janed', true], ['my whatsapp: +44 7700 900123', true], ['wa.me/447700900123', true],
  // Plain links stay plain text for everyone (T&S Phase 2 decision) — not contact info.
  ['check janedoe.com', false],
  ["let's meet at 7:30", false], ['dinner at 10pm?', false], ["I'm 29, you?", false], ['29yo and 5\'10"', false],
  ['it was $150 for both tickets', false], ['tickets were 150 dollars', false], ['about 12 miles from me', false], ['ran a 10k today', false],
  ['between 25-35 ideally', false], ['since 2019, so 5 years', false], ['meet @ the bar at 8', false], ['see you @ 7', false],
  ['I have 2 dogs and 1 cat', false], ['my number one rule is honesty', false], ['my snapdragon phone lol', false],
  ['my insta-worthy brunch', false], ['call me maybe 😂', false], ['the score was 21-14', false],
  ['ok… 1 2 3 4 5 6 7 8 9 10 lol', false], ['I live at 4th and Congress', false], ['room 1205, floor 12', false],
  ['zip is 78701', false], ['5 1 2 5 5 5 0 1 3 4', true], ['512 555 0134', true], ['my ig is janed', true], ['I counted 1, 2, 3, 4, 5, 6, 7, 8, 9, 10', false], ['order #48213', false], ['I paid 1,250 for rent', false], ['born 03/14/1995', false], ['my username is jane_d', true], ['my phone is dying brb', false], ['my insta is private lol', false], ['my snap is jane_d', true], ['my number is 5125550134', true], ['ig: janed', true], ['my cell is at 5%', false], ['flight UA 1532 lands 6:45', false], ['10/10 would recommend', false],
]

const SNAP_WHATSAPP: [string, boolean][] = [
  ['my sc is jane_d', true], ['my snapchat is jane.doe', true], ['SC: janed99', true], ['hmu on snap', true], ['snap me at jane_d22', true],
  ['snap me: jane_d22', true], ['add me on snapchat', true], ['snapchat.com/add/janed', true], ['whatsapp me on +44 7700 900123', true],
  ['wa me at 5125550134', true], ['my whatsapp is 512 555 0134', true], ['t.me/janed', true], ['instagram.com/jane.doe', true],
  ['snap me a pic of the view', false], ['do you use whatsapp?', false], ['I hate snapchat filters', false], ["what's your favourite app?", false],
  ['sending you a snap later lol', false], ['my snapchat streak died', false],
]

test('detector: the plan’s Appendix A cases', () => {
  for (const [t, want] of APPENDIX) assert.equal(detectContact(t).length > 0, want, t)
})

test('detector: Snapchat and WhatsApp phrasing', () => {
  for (const [t, want] of SNAP_WHATSAPP) assert.equal(detectContact(t).length > 0, want, t)
})

test('masking hides the details and keeps the rest', () => {
  assert.equal(maskContact('call me 512-555-0134 tonight'), `call me ${CONTACT_MASK} tonight`)
  assert.equal(maskContact('hey @jane.doe23 hi'), `hey ${CONTACT_MASK} hi`)
  assert.ok(!maskContact('mail jane.doe@gmail.com pls').includes('gmail'))
  assert.ok(!maskContact('5 1 2 5 5 5 0 1 3 4').match(/\d/))
  assert.ok(!maskContact('my snap is jane_d').includes('jane_d'))
  assert.equal(maskContact('see you at 7:30 at the bar'), 'see you at 7:30 at the bar')
  for (const [t, want] of [...APPENDIX, ...SNAP_WHATSAPP]) if (want) assert.equal(detectContact(maskContact(t)).length, 0, `masked: ${t} → ${maskContact(t)}`)
})

test('the app’s copy of the detector matches the server’s', () => {
  const body = (p: string) => readFileSync(new URL(p, `file://${__dirname}/`), 'utf8').split('\n').slice(1).join('\n')
  assert.equal(body('../../../src/services/contactDetect.ts'), body('../../src/shared/contactDetect.ts'))
})
