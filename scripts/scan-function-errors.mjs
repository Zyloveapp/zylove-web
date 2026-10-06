// Post-deploy log scan: out-of-memory crashes and other errors from Cloud
// Functions / Cloud Run since a given time. Part of DEPLOY_CHECKLIST.md —
// run right after a deploy and again 30 minutes later (cold starts that
// run out of memory only show up once real traffic hits each function).
//
//   node scripts/scan-function-errors.mjs 2026-10-06T12:56:45Z
//
// Exit 1 if any out-of-memory crash is found. Credentials: Application
// Default Credentials (quota project set explicitly).

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { GoogleAuth } = require('google-auth-library')

const since = process.argv[2]
if (!since || Number.isNaN(Date.parse(since))) {
  console.error('Usage: node scripts/scan-function-errors.mjs <ISO time of the deploy>')
  process.exit(1)
}
const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient()
const list = async (filter) =>
  (
    await client.request({
      url: 'https://logging.googleapis.com/v2/entries:list',
      method: 'POST',
      headers: { 'x-goog-user-project': 'zylove' },
      data: { resourceNames: ['projects/zylove'], pageSize: 200, orderBy: 'timestamp desc', filter: `timestamp>="${since}" AND (${filter})` },
    })
  ).data.entries ?? []
const service = (e) => e.resource?.labels?.service_name ?? e.resource?.labels?.function_name ?? '?'
const text = (e) => String(e.textPayload ?? e.jsonPayload?.message ?? e.protoPayload?.status?.message ?? `HTTP ${e.httpRequest?.status ?? '?'}`)

const oom = await list('textPayload:"Memory limit" OR textPayload:"memory limit" OR jsonPayload.message:"Memory limit"')
const errors = await list('(resource.type="cloud_run_revision" OR resource.type="cloud_function") AND (severity>=ERROR OR httpRequest.status>=500)')
const count = (entries) => entries.reduce((m, e) => m.set(service(e), (m.get(service(e)) ?? 0) + 1), new Map())

console.log(`Since ${since}:`)
console.log(`  out-of-memory: ${oom.length}${oom.length ? ' → ' + [...count(oom)].map(([s, n]) => `${s} ×${n}`).join(', ') : ''}`)
console.log(`  errors / 5xx:  ${errors.length}${errors.length ? ' → ' + [...count(errors)].map(([s, n]) => `${s} ×${n}`).join(', ') : ''}`)
for (const e of errors.slice(0, 5)) console.log(`    ${e.timestamp} ${service(e)}: ${text(e).slice(0, 120)}`)
process.exit(oom.length ? 1 : 0)
