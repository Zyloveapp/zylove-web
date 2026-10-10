// F-113 (M2): the script Content-Security-Policy is Report-Only until its
// reports are clean (see the plan in handoff). These keep it enforceable:
// no unsafe script sources, every inline script in index.html allowed by
// its hash, and reports going somewhere.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..', '..')
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] }
const headers = vercel.headers.flatMap((h) => h.headers)
const header = (key: string) => headers.find((h) => h.key === key)?.value ?? ''
const directive = (policy: string, name: string) =>
  policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? ''

test('the Report-Only script-src allows no unsafe sources', () => {
  const scriptSrc = directive(header('Content-Security-Policy-Report-Only'), 'script-src')
  assert.ok(scriptSrc, 'script-src present')
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", 'data:', '*', 'http:']) {
    assert.equal(scriptSrc.split(/\s+/).includes(bad), false, `script-src has ${bad}`)
  }
  assert.equal(directive(header('Content-Security-Policy-Report-Only'), 'object-src'), "object-src 'none'")
})

test('every inline script in index.html is allowed by its hash', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  const scriptSrc = directive(header('Content-Security-Policy-Report-Only'), 'script-src')
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.ok(inline.length >= 1)
  for (const body of inline) {
    const hash = createHash('sha256').update(body).digest('base64')
    assert.ok(scriptSrc.includes(`'sha256-${hash}'`), `inline script not hashed: sha256-${hash}`)
  }
})

test('reports are sent, and the enforced policy keeps its framing and object rules', () => {
  const ro = header('Content-Security-Policy-Report-Only')
  assert.match(ro, /report-uri https:\/\//)
  assert.match(ro, /report-to csp/)
  assert.match(header('Reporting-Endpoints'), /csp="https:\/\//)
  const enforced = header('Content-Security-Policy')
  assert.match(enforced, /frame-ancestors 'none'/)
  assert.match(enforced, /object-src 'none'/)
})
