// T&S Phase 4 — what goes into the reporter's PDF.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { pdfLines } from '../src/evidence'

test('reporter PDF: names as shown, the chosen messages, verification — no phone, location or private data', () => {
  const lines = pdfLines({
    reportedName: 'Rex',
    categories: ['scam', 'felt_unsafe'],
    createdAt: Date.UTC(2026, 9, 7, 20, 0),
    reference: 'abcdef1234567890',
    items: [
      { msgId: 'm1', from: 'reported', sentAt: Date.UTC(2026, 9, 7, 19, 0), type: 'text', text: 'send me $200 now', photo: null, verdict: 'verified' },
      { msgId: 'm2', from: 'reporter', sentAt: null, type: 'text', text: 'no', photo: null, verdict: 'unverified' },
      { msgId: 'm3', from: 'reported', sentAt: null, type: 'photo', text: null, photo: 'AAAA', verdict: 'mismatch' },
    ],
  })
  const all = lines.map((l) => l.text).join('\n')
  assert.match(all, /About: Rex/)
  assert.match(all, /Scam or asked for money, I felt unsafe/)
  assert.match(all, /Rex · .* · Verified/)
  assert.match(all, /send me \$200 now/)
  assert.match(all, /You · time unknown · Unverified context/)
  assert.match(all, /\[Photo — attached to your report\]/)
  assert.match(all, /Couldn't be verified/)
  assert.match(all, /Reference abcdef12/)
  assert.ok(!/\+?\d{10,}|phone|latitude|longitude|geohash|email|@/i.test(all), all)
})
