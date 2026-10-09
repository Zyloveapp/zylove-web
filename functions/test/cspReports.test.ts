// F-082: CSP violation reports reduced to counts per directive|host
// (functions/src/cspReports.ts) — no URLs, paths or query strings kept.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  CSP_MAX_BODY,
  CSP_OVERFLOW_KEY,
  CSP_PER_IP,
  aggregateCsp,
  blockedHost,
  capKeys,
  cspDay,
  directiveOf,
  parseCspReports,
} from '../src/cspReports'

const REPORT_URI = JSON.stringify({
  'csp-report': {
    'document-uri': 'https://zylove.app/matches?uid=abc',
    'blocked-uri': 'https://evil.example.com/x.js?token=secret',
    'effective-directive': 'script-src-elem',
    'violated-directive': 'script-src',
    'original-policy': "default-src 'self'",
  },
})

const REPORTING_API = JSON.stringify([
  { type: 'csp-violation', url: 'https://zylove.app/', body: { documentURL: 'https://zylove.app/', blockedURL: 'inline', effectiveDirective: 'script-src-elem', disposition: 'report' } },
  { type: 'csp-violation', body: { blockedURL: 'https://cdn.example.org:8443/a.css', effectiveDirective: 'style-src-elem' } },
  { type: 'deprecation', body: { id: 'x' } },
  { type: 'csp-violation', body: { blockedURL: 'eval', violatedDirective: 'script-src' } },
])

test('limits: 16 KB bodies, 60 an hour per address', () => {
  assert.equal(CSP_MAX_BODY, 16 * 1024)
  assert.deepEqual(CSP_PER_IP, { max: 60, windowMs: 60 * 60 * 1000 })
})

test('report-uri body: one hit, host only', () => {
  assert.deepEqual(parseCspReports('application/csp-report', REPORT_URI), [{ directive: 'script-src-elem', host: 'evil.example.com' }])
  assert.deepEqual(parseCspReports('application/json; charset=utf-8', REPORT_URI), [{ directive: 'script-src-elem', host: 'evil.example.com' }])
})

test('Reporting API body: csp-violation entries only', () => {
  assert.deepEqual(parseCspReports('application/reports+json', REPORTING_API), [
    { directive: 'script-src-elem', host: 'inline' },
    { directive: 'style-src-elem', host: 'cdn.example.org' },
    { directive: 'script-src', host: 'eval' },
  ])
})

test('refused: other content types, bad JSON, not a report', () => {
  assert.throws(() => parseCspReports('text/plain', REPORT_URI))
  assert.throws(() => parseCspReports(undefined, REPORT_URI))
  assert.throws(() => parseCspReports('application/csp-report', '{nope'))
  assert.throws(() => parseCspReports('application/csp-report', '{"hello":1}'))
})

test('blocked host: never a path, query or credentials', () => {
  assert.equal(blockedHost('https://user:pw@a.example.com/p?q=1#f'), 'a.example.com')
  assert.equal(blockedHost('wss://socket.example.com/'), 'socket.example.com')
  assert.equal(blockedHost('data'), 'data')
  assert.equal(blockedHost('data:image/png;base64,AAAA'), 'data')
  assert.equal(blockedHost('blob:https://zylove.app/uuid'), 'blob')
  assert.equal(blockedHost('chrome-extension://abcdef/script.js'), 'chrome-extension')
  assert.equal(blockedHost('INLINE'), 'inline')
  assert.equal(blockedHost(''), 'none')
  assert.equal(blockedHost(undefined), 'none')
  assert.equal(blockedHost('not a url at all'), 'other')
  assert.equal(blockedHost(42), 'none')
})

test('directive: the name only, or unknown', () => {
  assert.equal(directiveOf("script-src 'self' https://x"), 'script-src')
  assert.equal(directiveOf('Img-Src'), 'img-src')
  assert.equal(directiveOf('<script>'), 'unknown')
  assert.equal(directiveOf(undefined), 'unknown')
})

test('aggregate and cap: counts per key, new keys past the cap fold into overflow', () => {
  const counts = aggregateCsp([
    { directive: 'script-src', host: 'inline' },
    { directive: 'script-src', host: 'inline' },
    { directive: 'img-src', host: 'a.com' },
  ])
  assert.deepEqual([...counts], [['script-src|inline', 2], ['img-src|a.com', 1]])
  assert.deepEqual([...capKeys(['script-src|inline'], counts, 1)], [['script-src|inline', 2], [CSP_OVERFLOW_KEY, 1]])
  assert.deepEqual([...capKeys([], counts, 5)], [...counts])
})

test('day key: UTC date', () => {
  assert.equal(cspDay(Date.UTC(2026, 9, 8, 23, 59)), '2026-10-08')
})
