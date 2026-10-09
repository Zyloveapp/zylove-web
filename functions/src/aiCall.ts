import { HttpsError } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { takeQuota, type Feature } from './usage'
import { takeRateLimit } from './rateLimits'
import type { ImageBlock } from './reviewPhotos'

// Every paid AI call from a callable goes through here (C2, fresh-eyes
// review 2026-10-09): a per-uid rate limit, then the plan's allowance
// (usage.ts), then the model. The use is given back only when no model call
// was billed — the request failed (network error, timeout before an answer)
// or Anthropic answered non-2xx. A 2xx is billed, so it counts even when the
// reply is then filtered (a link in a bio), unparseable (a scorecard) or
// empty: refunding those let a caller who steers the output loop paid calls
// without limit.

export const MODEL = 'claude-sonnet-4-6'
const API_URL = 'https://api.anthropic.com/v1/messages'

// The backstop on top of the plan's allowance, per callable and uid. Every
// allowance is at most 5 a day (usage.ts QUOTAS), so a member never meets
// it; it caps what calls that fail and are given back can add up to.
export const AI_RATE_LIMIT = { max: 10, windowMs: 60 * 60 * 1000 }
// No prompt goes out longer than this (H7). The longest real one (a review
// with every profile field at the caps in promptCaps.ts) is under 15k.
export const MAX_PROMPT_CHARS = 20_000
// An answer slower than this is treated as no answer (and given back).
const DEFAULT_TIMEOUT_MS = 50_000

// The model call itself failed: nothing was billed.
export class AiCallFailed extends Error {}

// Over AI_RATE_LIMIT (a 'resource-exhausted' to callers that pass it on).
export class AiBusy extends HttpsError {
  constructor() {
    super('resource-exhausted', 'Too many requests. Try again in a few minutes.')
  }
}

export interface ModelRequest {
  label: string
  prompt: string
  maxTokens: number
  temperature?: number
  // Photo blocks (a profile review), sent before the prompt.
  images?: ImageBlock[]
  timeoutMs?: number
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export function extractText(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('content' in body)) return ''
  const { content } = body as { content: unknown }
  if (!Array.isArray(content)) return ''
  const first: unknown = content[0]
  if (typeof first !== 'object' || first === null || !('text' in first)) return ''
  const { text } = first as { text: unknown }
  return typeof text === 'string' ? text.trim() : ''
}

// One reserved use: its model calls, and the refund rule.
export class AiSpend {
  private billed = false
  private refunded = false

  constructor(
    private readonly refund: () => Promise<void>,
    private readonly apiKey: string,
    private readonly fetchFn: Fetch,
  ) {}

  get wasBilled(): boolean {
    return this.billed
  }

  // The reply's text ('' when there's none). Throws AiCallFailed when the
  // call failed — never after a 2xx.
  async ask(req: ModelRequest): Promise<string> {
    if (req.prompt.length > MAX_PROMPT_CHARS) {
      logger.error(`${req.label}: prompt over the cap, not sent`, { length: req.prompt.length })
      throw new AiCallFailed('prompt too long')
    }
    let response: Response
    try {
      response = await this.fetchFn(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: req.maxTokens,
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          messages: [{ role: 'user', content: req.images?.length ? [...req.images, { type: 'text', text: req.prompt }] : req.prompt }],
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (err) {
      logger.error(`${req.label}: Anthropic request failed`, { message: err instanceof Error ? err.message : String(err) })
      throw new AiCallFailed('request failed')
    }
    if (!response.ok) {
      logger.error(`${req.label}: Anthropic API error`, { status: response.status })
      throw new AiCallFailed(`status ${response.status}`)
    }
    this.billed = true
    return extractText(await response.json().catch(() => null))
  }

  // For every way the feature didn't deliver: gives the use back only if no
  // call was billed. Once.
  async refundIfUnbilled(): Promise<void> {
    if (this.billed || this.refunded) return
    this.refunded = true
    await this.refund()
  }
}

export interface AiDeps {
  rateLimit: (uid: string, key: string, limit: { max: number; windowMs: number }) => Promise<void>
  quota: (uid: string, feature: Feature) => Promise<() => Promise<void>>
  fetch: Fetch
}
const LIVE: AiDeps = {
  rateLimit: takeRateLimit,
  quota: (uid, feature) => takeQuota(uid, feature),
  // Looked up per call (the e2e harness swaps the global fetch).
  fetch: (url, init) => globalThis.fetch(url, init),
}

// Takes the rate-limit slot (AiBusy when full), then one use of `feature`
// (takeQuota's refusals pass through). Callers then ask() and, when the
// feature didn't deliver, refundIfUnbilled().
export async function startAiSpend(uid: string, feature: Feature, apiKey: string, deps: AiDeps = LIVE): Promise<AiSpend> {
  try {
    await deps.rateLimit(uid, `ai_${feature}`, AI_RATE_LIMIT)
  } catch {
    throw new AiBusy()
  }
  const refund = await deps.quota(uid, feature)
  return new AiSpend(refund, apiKey, deps.fetch)
}
