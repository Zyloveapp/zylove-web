import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, callAs, db, PROJECT } from './helpers.mjs'

// F-082: the CSP report endpoint (functions/src/cspReports.ts). Browsers
// POST violation reports (report-uri: application/csp-report; Reporting API:
// application/reports+json); only counts per directive|blocked host are kept
// in cspReports/{UTC day} — no URLs, query strings or page addresses. The
// parsing and capping are unit-tested (functions/test/cspReports.test.ts).
const FN = `http://127.0.0.1:5311/${PROJECT}/us-central1`
const today = () => new Date().toISOString().slice(0, 10)

test.beforeEach(resetEmulators)

const post = (body, type, extra = {}) =>
  fetch(`${FN}/cspReport`, { method: 'POST', headers: { 'Content-Type': type, ...extra }, body })

const REPORT_URI = JSON.stringify({
  'csp-report': {
    'document-uri': 'https://zylove.app/matches?secret=abc',
    'blocked-uri': 'https://evil.example.com/x.js?token=t0k3n',
    'effective-directive': 'script-src-elem',
    'violated-directive': 'script-src-elem',
  },
})

const REPORTING_API = JSON.stringify([
  { type: 'csp-violation', url: 'https://zylove.app/', body: { documentURL: 'https://zylove.app/chat/123', blockedURL: 'inline', effectiveDirective: 'script-src-elem', disposition: 'report' } },
  { type: 'csp-violation', body: { blockedURL: 'https://evil.example.com/y.js', effectiveDirective: 'script-src-elem' } },
])

test('csp reports: both formats counted per directive|host, nothing else stored; admins read the week', async () => {
  expect((await post(REPORT_URI, 'application/csp-report')).status).toBe(204)
  expect((await post(REPORTING_API, 'application/reports+json')).status).toBe(204)

  const doc = (await db.doc(`cspReports/${today()}`).get()).data()
  expect(doc.day).toBe(today())
  expect(doc.total).toBe(3)
  expect(doc.counts).toEqual({ 'script-src-elem|evil.example.com': 2, 'script-src-elem|inline': 1 })
  expect(doc.updatedAt).toBeTruthy()
  // No URL, path, query string or page address anywhere in the doc.
  const raw = JSON.stringify(doc)
  for (const s of ['t0k3n', 'secret', '/x.js', 'matches', 'chat/123', 'https://']) expect(raw).not.toContain(s)
  expect(Object.keys(doc).sort()).toEqual(['counts', 'day', 'total', 'updatedAt'])

  const admin = await seedUser('Kim', { isAdmin: true })
  const { days } = await callAs(admin.uid, 'adminCspReports')
  expect(days).toHaveLength(7)
  expect(days[0]).toEqual({
    day: today(),
    total: 3,
    counts: [
      { directive: 'script-src-elem', host: 'evil.example.com', n: 2 },
      { directive: 'script-src-elem', host: 'inline', n: 1 },
    ],
  })
  const user = await seedUser('Lee')
  await expect(callAs(user.uid, 'adminCspReports')).rejects.toThrow(/permission-denied|Admins only/i)
})

test('csp reports: non-POST, oversized, wrong type and malformed bodies are refused and store nothing', async () => {
  expect((await fetch(`${FN}/cspReport`)).status).toBe(405)
  expect((await fetch(`${FN}/cspReport`, { method: 'PUT', body: REPORT_URI })).status).toBe(405)

  const big = JSON.stringify({ 'csp-report': { 'blocked-uri': 'https://a.example.com/', 'effective-directive': 'img-src', pad: 'x'.repeat(17 * 1024) } })
  expect((await post(big, 'application/csp-report')).status).toBe(413)
  expect((await post(REPORT_URI, 'text/plain')).status).toBe(400)
  expect((await post('{not json', 'application/csp-report')).status).toBe(400)
  expect((await post('{"hello":1}', 'application/json')).status).toBe(400)

  expect((await db.doc(`cspReports/${today()}`).get()).exists).toBe(false)
})

test('csp reports: rate limited per caller address (hashed key, no address stored)', async () => {
  let last = 0
  for (let i = 0; i < 61; i++) last = (await post(REPORT_URI, 'application/csp-report')).status
  expect(last).toBe(429)
  expect((await db.doc(`cspReports/${today()}`).get()).data().total).toBe(60)
  const limits = await db.collection('rateLimits').get()
  const keyed = limits.docs.filter((d) => Array.isArray(d.data().cspReport))
  expect(keyed).toHaveLength(1)
  expect(keyed[0].id).toMatch(/^ip_[0-9a-f]{32}$/)
})
