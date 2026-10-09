import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { requireAdminAudited } from './audit'
import { takeRateLimit } from './rateLimits'
import { clientIp, ipRateKey } from './clientIp'

// F-082: where browsers send Content-Security-Policy violation reports
// (vercel.json's Report-Only policy: report-uri for older browsers,
// report-to / Reporting-Endpoints for the Reporting API), so the script
// policy can be enforced once a week of reports is clean.
//
//   cspReports/{YYYY-MM-DD} (UTC; server-only) { day, counts: {
//     "<effectiveDirective>|<blockedHost>": n }, total, updatedAt }
//
// Only aggregated counts: the blocked resource's host (or a keyword such as
// "inline"/"eval", or a scheme such as "data"/"chrome-extension") — never a
// full URL, path or query string, never the page URL, never the caller's
// address (only hashed into the rate-limit key). Nothing per report is
// logged. Kept 90 days (retention.ts). adminCspReports shows the last week
// on /admin/cities.

const HOUR_MS = 60 * 60 * 1000
export const CSP_MAX_BODY = 16 * 1024
export const CSP_PER_IP = { max: 60, windowMs: HOUR_MS }
// Distinct directive|host keys kept per day; the rest count as overflow|other.
export const CSP_MAX_KEYS = 200
// Reports counted per day in all; past it they're accepted and dropped.
export const CSP_DAILY_MAX = 20_000
// Reporting API batches can hold many reports; only this many are read.
const MAX_REPORTS_PER_BODY = 50
export const CSP_OVERFLOW_KEY = 'overflow|other'

const CONTENT_TYPES = new Set(['application/csp-report', 'application/reports+json', 'application/json'])
// blocked-uri / blockedURL values that aren't URLs.
const KEYWORDS = new Set(['inline', 'eval', 'self', 'wasm-eval', 'trusted-types-policy', 'trusted-types-sink', 'none'])
const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])
const SCHEME = /^[a-z][a-z0-9+.-]{0,30}$/
const HOST = /^[a-z0-9.-]{1,253}$/
const DIRECTIVE = /^[a-z-]{1,40}$/

export interface CspHit {
  directive: string
  host: string
}

// The directive name only ("script-src-elem 'self' …" → "script-src-elem").
export function directiveOf(v: unknown): string {
  const d = typeof v === 'string' ? v.trim().toLowerCase().split(/\s+/)[0] ?? '' : ''
  return DIRECTIVE.test(d) ? d : 'unknown'
}

// What was blocked, reduced to a host, a keyword or a scheme.
export function blockedHost(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!s) return 'none'
  if (KEYWORDS.has(s)) return s
  try {
    const u = new URL(s)
    if (WEB_SCHEMES.has(u.protocol)) return HOST.test(u.hostname) ? u.hostname.slice(0, 100) : 'other'
    const scheme = u.protocol.replace(/:$/, '')
    return SCHEME.test(scheme) ? scheme : 'other'
  } catch {
    // A bare scheme ("data", "blob:") as some browsers report it.
    const scheme = s.replace(/:$/, '')
    return SCHEME.test(scheme) ? scheme : 'other'
  }
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

// The violations in a request body: report-uri's {"csp-report": {…}} or the
// Reporting API's [{type: "csp-violation", body: {…}}, …]. Throws on a
// content type or body that's neither.
export function parseCspReports(contentType: string | undefined, raw: string): CspHit[] {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (!CONTENT_TYPES.has(type)) throw new Error('Unsupported content type')
  const parsed: unknown = JSON.parse(raw)
  if (Array.isArray(parsed)) {
    return parsed
      .slice(0, MAX_REPORTS_PER_BODY)
      .map(obj)
      .filter((r): r is Record<string, unknown> => r !== null && r.type === 'csp-violation')
      .map((r) => obj(r.body))
      .filter((b): b is Record<string, unknown> => b !== null)
      .map((b) => ({ directive: directiveOf(b.effectiveDirective ?? b.violatedDirective), host: blockedHost(b.blockedURL) }))
  }
  const report = obj(obj(parsed)?.['csp-report'])
  if (!report) throw new Error('Not a CSP report')
  return [{ directive: directiveOf(report['effective-directive'] ?? report['violated-directive']), host: blockedHost(report['blocked-uri']) }]
}

// Counts per "directive|host".
export function aggregateCsp(hits: CspHit[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const h of hits) {
    const key = `${h.directive}|${h.host}`
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

// The increments to apply to a day doc that already has `existing` keys:
// new keys past CSP_MAX_KEYS fold into the overflow key.
export function capKeys(existing: Iterable<string>, counts: Map<string, number>, maxKeys = CSP_MAX_KEYS): Map<string, number> {
  const seen = new Set(existing)
  const out = new Map<string, number>()
  for (const [key, n] of counts) {
    let k = key
    if (!seen.has(key)) {
      if (seen.size < maxKeys) seen.add(key)
      else k = CSP_OVERFLOW_KEY
    }
    out.set(k, (out.get(k) ?? 0) + n)
  }
  return out
}

export const cspDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

type RawBodyRequest = { rawBody?: unknown; body?: unknown }

function bodyText(req: RawBodyRequest): string {
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.isBuffer(req.body) ? req.body : null
  if (raw) return raw.toString('utf8')
  if (typeof req.body === 'string') return req.body
  return req.body === undefined ? '' : JSON.stringify(req.body)
}

export const cspReport = onRequest(
  // The Reporting API sends a CORS preflight (application/reports+json).
  { timeoutSeconds: 15, memory: '256MiB', invoker: 'public', cors: ['https://zylove.app'] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).send('Method not allowed')
      return
    }
    const declared = Number(req.headers['content-length'] ?? 0)
    const text = bodyText(req as RawBodyRequest)
    if (declared > CSP_MAX_BODY || Buffer.byteLength(text, 'utf8') > CSP_MAX_BODY) {
      res.status(413).send('Too large')
      return
    }
    let hits: CspHit[]
    try {
      hits = parseCspReports(req.headers['content-type'], text)
    } catch {
      res.status(400).send('Bad report')
      return
    }
    try {
      await takeRateLimit(ipRateKey(clientIp(req as never)), 'cspReport', CSP_PER_IP)
    } catch (err) {
      if (err instanceof HttpsError && err.code === 'resource-exhausted') {
        res.status(429).send('Too many reports')
        return
      }
      throw err
    }
    if (hits.length === 0) {
      res.status(204).end()
      return
    }
    try {
      const db = getFirestore()
      const now = Date.now()
      const day = cspDay(now)
      const ref = db.doc(`cspReports/${day}`)
      const counts = aggregateCsp(hits)
      await db.runTransaction(async (tx) => {
        const d = (await tx.get(ref)).data()
        if (typeof d?.total === 'number' && d.total >= CSP_DAILY_MAX) return
        const capped = capKeys(Object.keys(obj(d?.counts) ?? {}), counts)
        // set + merge takes map keys literally, so the dots in a host are safe.
        tx.set(
          ref,
          {
            day,
            counts: Object.fromEntries([...capped].map(([k, n]) => [k, FieldValue.increment(n)])),
            total: FieldValue.increment(hits.length),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        )
      })
      res.status(204).end()
    } catch (err) {
      logger.error('cspReport failed', { message: err instanceof Error ? err.message : String(err) })
      res.status(500).send('Error')
    }
  },
)

export interface CspDayCounts {
  day: string
  total: number
  counts: { directive: string; host: string; n: number }[]
}

// The last 7 days (UTC), newest first, each day's keys by count.
export const adminCspReports = onCall(
  { timeoutSeconds: 30, memory: '256MiB', invoker: 'public' },
  async (request): Promise<{ days: CspDayCounts[] }> => {
    await requireAdminAudited(request.auth, { action: 'csp.view' })
    const db = getFirestore()
    const now = Date.now()
    const ids = Array.from({ length: 7 }, (_, i) => cspDay(now - i * 24 * HOUR_MS))
    const snaps = await db.getAll(...ids.map((id) => db.doc(`cspReports/${id}`)))
    const days = snaps.map((s, i): CspDayCounts => {
      const d = s.data() ?? {}
      const counts = Object.entries(obj(d.counts) ?? {})
        .filter((e): e is [string, number] => typeof e[1] === 'number')
        .map(([k, n]) => {
          const at = k.indexOf('|')
          return { directive: at < 0 ? k : k.slice(0, at), host: at < 0 ? '' : k.slice(at + 1), n }
        })
        .sort((a, b) => b.n - a.n)
        .slice(0, 100)
      return { day: ids[i]!, total: typeof d.total === 'number' ? d.total : 0, counts }
    })
    return { days }
  },
)
