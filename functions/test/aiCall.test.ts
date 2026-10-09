// C2 (fresh-eyes review 2026-10-09): an AI use is given back only when the
// model call itself failed — a 2xx is billed and counts, whatever the reply
// — and every AI callable takes a per-uid rate-limit slot first.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpsError } from 'firebase-functions/v2/https'
import { AI_RATE_LIMIT, AiBusy, AiCallFailed, MAX_PROMPT_CHARS, startAiSpend, type AiDeps } from '../src/aiCall'

const reply = (text: string, status = 200) =>
  new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status, headers: { 'Content-Type': 'application/json' } })

// Deps that record what happened: rate-limit keys, quota takes, refunds, requests.
function fake(answer: () => Promise<Response>, { busy = false, quotaError = null as Error | null } = {}) {
  const log = { rate: [] as string[], limits: [] as unknown[], quota: [] as string[], refunds: 0, requests: [] as string[] }
  const deps: AiDeps = {
    rateLimit: async (uid, key, limit) => {
      log.rate.push(`${uid}:${key}`)
      log.limits.push(limit)
      if (busy) throw new HttpsError('resource-exhausted', 'Too many requests. Try again in a few minutes.')
    },
    quota: async (uid, feature) => {
      if (quotaError) throw quotaError
      log.quota.push(`${uid}:${feature}`)
      return async () => {
        log.refunds++
      }
    },
    fetch: async (_url, init) => {
      log.requests.push(String(init.body))
      return answer()
    },
  }
  return { deps, log }
}

test('a 2xx is billed: an empty, filtered or unparseable reply is not given back', async () => {
  for (const text of ['', 'Find me at acme.io', 'not json']) {
    const { deps, log } = fake(async () => reply(text))
    const ai = await startAiSpend('u1', 'sparkReview', 'k', deps)
    assert.equal(await ai.ask({ label: 't', prompt: 'p', maxTokens: 10 }), text)
    // The caller found nothing usable and asks for the refund — refused.
    await ai.refundIfUnbilled()
    assert.equal(ai.wasBilled, true)
    assert.equal(log.refunds, 0, text)
  }
  // A 2xx whose body isn't JSON at all is still billed.
  const { deps, log } = fake(async () => new Response('<html>', { status: 200 }))
  const ai = await startAiSpend('u1', 'sparkReview', 'k', deps)
  assert.equal(await ai.ask({ label: 't', prompt: 'p', maxTokens: 10 }), '')
  await ai.refundIfUnbilled()
  assert.equal(log.refunds, 0)
})

test('a failed call is given back: network error, timeout, non-2xx', async () => {
  const failures: (() => Promise<Response>)[] = [
    async () => {
      throw new TypeError('fetch failed')
    },
    async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    },
    async () => reply('', 529),
    async () => reply('', 400),
  ]
  for (const answer of failures) {
    const { deps, log } = fake(answer)
    const ai = await startAiSpend('u1', 'sparkBio', 'k', deps)
    await assert.rejects(ai.ask({ label: 't', prompt: 'p', maxTokens: 10 }), AiCallFailed)
    await ai.refundIfUnbilled()
    await ai.refundIfUnbilled() // once only
    assert.equal(log.refunds, 1)
  }
})

test('several calls (Go Deeper): one answered call makes the use count, even if a later one fails', async () => {
  let n = 0
  const { deps, log } = fake(async () => (n++ === 0 ? reply('Q?') : reply('', 500)))
  const ai = await startAiSpend('u1', 'sparkGoDeeper', 'k', deps)
  await ai.ask({ label: 't', prompt: 'p', maxTokens: 10 })
  await assert.rejects(ai.ask({ label: 't', prompt: 'p', maxTokens: 10 }), AiCallFailed)
  await ai.refundIfUnbilled()
  assert.equal(log.refunds, 0)
})

test('a prompt over the cap is never sent (and so not billed)', async () => {
  const { deps, log } = fake(async () => reply('x'))
  const ai = await startAiSpend('u1', 'sparkReview', 'k', deps)
  await assert.rejects(ai.ask({ label: 't', prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1), maxTokens: 10 }), AiCallFailed)
  assert.equal(log.requests.length, 0)
  await ai.refundIfUnbilled()
  assert.equal(log.refunds, 1)
})

test('the request: model, max_tokens, temperature, photos before the prompt', async () => {
  const { deps, log } = fake(async () => reply('x'))
  const ai = await startAiSpend('u1', 'sparkReview', 'k', deps)
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg', data: 'AAAA' } }
  await ai.ask({ label: 't', prompt: 'hello', maxTokens: 123, temperature: 0.9, images: [image] as never })
  const body = JSON.parse(log.requests[0])
  assert.equal(body.max_tokens, 123)
  assert.equal(body.temperature, 0.9)
  assert.deepEqual(body.messages[0].content[1], { type: 'text', text: 'hello' })
  assert.equal(body.messages[0].content[0].type, 'image')
})

test('rate limit first (per feature and uid, 10 an hour), then the allowance', async () => {
  assert.deepEqual(AI_RATE_LIMIT, { max: 10, windowMs: 60 * 60 * 1000 })
  const ok = fake(async () => reply('x'))
  await startAiSpend('u1', 'playReview', 'k', ok.deps)
  assert.deepEqual(ok.log.rate, ['u1:ai_playReview'])
  assert.deepEqual(ok.log.limits, [AI_RATE_LIMIT])
  assert.deepEqual(ok.log.quota, ['u1:playReview'])
  // Over the rate limit: AiBusy (a resource-exhausted HttpsError), and no
  // allowance taken.
  const busy = fake(async () => reply('x'), { busy: true })
  await assert.rejects(startAiSpend('u1', 'playReview', 'k', busy.deps), (err) => err instanceof AiBusy && err instanceof HttpsError && err.code === 'resource-exhausted')
  assert.deepEqual(busy.log.quota, [])
  // The allowance's own refusal passes through unchanged.
  const used = new HttpsError('resource-exhausted', 'used', { upgrade: 'elite' })
  const over = fake(async () => reply('x'), { quotaError: used })
  await assert.rejects(startAiSpend('u1', 'playReview', 'k', over.deps), (err) => err === used)
})

// Wiring: every callable that holds the Anthropic key reserves through
// startAiSpend, and nothing in index.ts calls the API directly.
test('every AI callable in index.ts goes through startAiSpend', () => {
  const src = readFileSync(join(__dirname, '../../src/index.ts'), 'utf8')
  assert.equal(src.includes('api.anthropic.com'), false)
  assert.equal(/\btakeQuota\(/.test(src), false)
  const callables = [...src.matchAll(/export const (\w+) = onCall\(\s*\{[^}]*secrets: \[[^\]]*anthropicKey/g)]
  const names = callables.map((m) => m[1]).sort()
  assert.deepEqual(names, [
    'generateConversationStarter', 'generatePlayBio', 'generatePlayGoDeeper', 'generateProfileQuestion',
    'generateSparkBio', 'generateSparkGoDeeper', 'reviewPlayProfile', 'reviewProfile',
  ])
  for (const m of callables) {
    const body = src.slice(m.index, src.indexOf('\n)\n', m.index))
    assert.match(body, /startAiSpend\(/, m[1])
  }
})
