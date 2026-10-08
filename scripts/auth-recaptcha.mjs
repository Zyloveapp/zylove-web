// Phone sign-in's reCAPTCHA (Identity Platform) — status and the few config
// changes the move to reCAPTCHA Enterprise ENFORCE needs. Read-only unless
// given a change; every change prints the config before and after, and each
// has its exact opposite as the rollback.
//
//   node scripts/auth-recaptcha.mjs status        config + the last 7 days of sends
//   node scripts/auth-recaptcha.mjs logging-on    request logging on (records 400 reasons)
//   node scripts/auth-recaptcha.mjs logging-off   rollback of logging-on
//   node scripts/auth-recaptcha.mjs enforce       phone reCAPTCHA Enterprise → ENFORCE
//   node scripts/auth-recaptcha.mjs audit         rollback of enforce (→ AUDIT)
//
// Credentials: Application Default Credentials (gcloud auth application-default login).

import { createRequire } from 'node:module'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { GoogleAuth } = require('google-auth-library')
const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient()
const CONFIG = 'https://identitytoolkit.googleapis.com/admin/v2/projects/zylove/config'
const H = { 'x-goog-user-project': 'zylove' }

async function config() {
  const d = (await client.request({ url: CONFIG, headers: H })).data
  return { phoneEnforcementState: d.recaptchaConfig?.phoneEnforcementState, useSmsTollFraudProtection: d.recaptchaConfig?.useSmsTollFraudProtection, tollFraudManagedRules: d.recaptchaConfig?.tollFraudManagedRules, requestLogging: d.monitoring?.requestLogging?.enabled === true }
}
async function patch(updateMask, data) {
  console.log('before:', JSON.stringify(await config()))
  await client.request({ url: `${CONFIG}?updateMask=${updateMask}`, method: 'PATCH', headers: H, data })
  console.log('after: ', JSON.stringify(await config()))
}

// Sends over the last `days` days, per day: SendVerificationCode 200/400,
// GetRecaptchaParam (= a fallback to reCAPTCHA v2), SignInWithPhoneNumber.
async function sends(days = 7) {
  const end = new Date().toISOString()
  const start = new Date(Date.now() - days * 864e5).toISOString()
  const r = await client.request({
    url: 'https://monitoring.googleapis.com/v3/projects/zylove/timeSeries',
    params: {
      filter: 'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.labels.service="identitytoolkit.googleapis.com"',
      'interval.startTime': start,
      'interval.endTime': end,
      'aggregation.alignmentPeriod': '86400s',
      'aggregation.perSeriesAligner': 'ALIGN_SUM',
    },
  })
  const rows = new Map()
  for (const ts of r.data.timeSeries ?? []) {
    const m = ts.resource.labels.method.split('.').pop()
    if (!/SendVerificationCode|GetRecaptchaParam|SignInWithPhoneNumber/.test(m)) continue
    for (const p of ts.points) {
      const day = p.interval.endTime.slice(0, 10)
      const k = `${m} ${ts.metric.labels.response_code}`
      rows.set(day, { ...(rows.get(day) ?? {}), [k]: Number(p.value.int64Value) + ((rows.get(day) ?? {})[k] ?? 0) })
    }
  }
  let send200 = 0, send400 = 0, fallback = 0
  for (const [day, v] of [...rows].sort()) {
    console.log(day, JSON.stringify(v))
    send200 += v['SendVerificationCode 200'] ?? 0
    send400 += v['SendVerificationCode 400'] ?? 0
    fallback += v['GetRecaptchaParam 200'] ?? 0
  }
  console.log(`\n${days} days: SendVerificationCode 200 = ${send200}, 400 = ${send400}; v2 fallbacks (GetRecaptchaParam) = ${fallback}`)
}

// Why sends were refused, from Identity Platform's request logs (logging-on;
// counts by error message only — no numbers or tokens).
async function refusals(days = 7) {
  const since = new Date(Date.now() - days * 864e5).toISOString()
  const r = await client.request({
    url: 'https://logging.googleapis.com/v2/entries:list',
    method: 'POST',
    data: {
      resourceNames: ['projects/zylove'],
      filter: `logName="projects/zylove/logs/identitytoolkit.googleapis.com%2Frequests" AND jsonPayload.methodName:"SendVerificationCode" AND jsonPayload.status.code>0 AND timestamp>="${since}"`,
      pageSize: 1000,
    },
  })
  const counts = {}
  for (const e of r.data.entries ?? []) {
    const k = String(e.jsonPayload?.status?.message ?? e.jsonPayload?.status?.code ?? 'unknown')
    counts[k] = (counts[k] ?? 0) + 1
  }
  console.log('refused sends by reason (request logs):', JSON.stringify(counts))
}

const cmd = process.argv[2] ?? 'status'
if (cmd === 'status') {
  console.log('config:', JSON.stringify(await config()))
  await sends()
  await refusals()
} else if (cmd === 'logging-on') await patch('monitoring.requestLogging.enabled', { monitoring: { requestLogging: { enabled: true } } })
else if (cmd === 'logging-off') await patch('monitoring.requestLogging.enabled', { monitoring: { requestLogging: { enabled: false } } })
else if (cmd === 'enforce') await patch('recaptchaConfig.phoneEnforcementState', { recaptchaConfig: { phoneEnforcementState: 'ENFORCE' } })
else if (cmd === 'audit') await patch('recaptchaConfig.phoneEnforcementState', { recaptchaConfig: { phoneEnforcementState: 'AUDIT' } })
else {
  console.error('status | logging-on | logging-off | enforce | audit')
  process.exit(1)
}
process.exit(0)
