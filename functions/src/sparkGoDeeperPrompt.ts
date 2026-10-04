// Spark Go Deeper — two personal questions written from the user's Spark
// onboarding answers (generateSparkGoDeeper). Inputs are validated against
// the label maps, so only known values reach the prompt.

import {
  CONFLICT_STYLE_LABELS,
  LIFESTYLE_TAG_LABELS,
  LOVE_LANGUAGE_LABELS,
  OPEN_TO_LABELS,
  PERSONALITY_TRAIT_LABELS,
  RELATIONSHIP_STATUS_LABELS,
  RELATIONSHIP_VALUE_LABELS,
  SPARK_PROMPTS,
  STRESS_RESPONSE_LABELS,
  TOGETHERNESS_STYLE_LABELS,
  UNIVERSAL_PROMPTS,
} from './shared/profile'

type Json = Record<string, unknown>

const MAX_ANSWER = 300
const MAX_ANSWERS = 6

export const SPARK_GO_DEEPER_FOCUS = [
  'what they bring to a relationship, their communication style, their emotional patterns',
  "what they're looking for, what a good relationship looks like for them, something unexpected about them",
] as const

export interface SparkGoDeeperRequest {
  personality: string[]
  values: string[]
  lifestyle: string[]
  loveGive: string[]
  loveReceive: string[]
  openTo: string[]
  relationshipStatus: string | null
  promptAnswers: { question: string; answer: string }[]
  conflict: string | null
  togetherness: string | null
  stress: string | null
}

function has(record: object, key: unknown): key is string {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(record, key)
}

function labelOf(v: unknown): string {
  if (typeof v === 'string') return v
  return typeof v === 'object' && v !== null && typeof (v as Json).label === 'string' ? ((v as Json).label as string) : ''
}

// Known keys only, as their display labels.
function labels(v: unknown, record: Record<string, unknown>): string[] {
  return Array.isArray(v) ? v.filter((k) => has(record, k)).map((k) => labelOf(record[k as string])).filter(Boolean) : []
}

function one(v: unknown, record: Record<string, unknown>): string | null {
  return has(record, v) ? labelOf(record[v]) || null : null
}

const PROMPT_TEXT = new Map([...UNIVERSAL_PROMPTS, ...SPARK_PROMPTS].map((p) => [p.id, p.text]))

function answers(v: unknown): { question: string; answer: string }[] {
  if (!Array.isArray(v)) return []
  return v
    .map((p) => p as Json)
    .map((p) => ({
      question: typeof p?.promptId === 'string' ? (PROMPT_TEXT.get(p.promptId) ?? '') : '',
      answer: typeof p?.answer === 'string' ? p.answer.trim().slice(0, MAX_ANSWER) : '',
    }))
    .filter((p) => p.question && p.answer)
    .slice(0, MAX_ANSWERS)
}

export function parseSparkGoDeeperRequest(raw: unknown): SparkGoDeeperRequest {
  const d: Json = typeof raw === 'object' && raw !== null ? (raw as Json) : {}
  return {
    personality: labels(d.personality, PERSONALITY_TRAIT_LABELS),
    values: labels(d.values, RELATIONSHIP_VALUE_LABELS),
    lifestyle: labels(d.lifestyle, LIFESTYLE_TAG_LABELS),
    loveGive: labels(d.loveLangGive, LOVE_LANGUAGE_LABELS),
    loveReceive: labels(d.loveLangReceive, LOVE_LANGUAGE_LABELS),
    openTo: labels(d.openTo, OPEN_TO_LABELS),
    relationshipStatus: one(d.relationshipStatus, RELATIONSHIP_STATUS_LABELS),
    promptAnswers: answers(d.promptAnswers),
    conflict: one(d.conflict, CONFLICT_STYLE_LABELS),
    togetherness: one(d.togetherness, TOGETHERNESS_STYLE_LABELS),
    stress: one(d.stress, STRESS_RESPONSE_LABELS),
  }
}

const list = (l: string[]) => (l.length ? l.join(', ') : 'not shared')

export function buildSparkGoDeeperPrompt(
  r: SparkGoDeeperRequest,
  { focus, previousQuestion }: { focus: string; previousQuestion?: string },
): string {
  const prompts = r.promptAnswers.map((p) => `Q: ${p.question}\nA: ${p.answer}`).join('\n\n') || 'none yet'
  const operate = [
    r.conflict && `conflict → ${r.conflict}`,
    r.togetherness && `togetherness → ${r.togetherness}`,
    r.stress && `stress → ${r.stress}`,
  ]
    .filter(Boolean)
    .join(', ')
  return [
    'You are generating a personal Go Deeper question for a dating profile on Zylove Spark — an intentional dating platform for people looking for real connections.',
    '',
    'The user has shared the following about themselves:',
    '',
    `Personality: ${list(r.personality)}`,
    `Values: ${list(r.values)}`,
    `Lifestyle: ${list(r.lifestyle)}`,
    `Shows love by: ${list(r.loveGive)}`,
    `Feels loved when: ${list(r.loveReceive)}`,
    `Open to: ${list(r.openTo)}`,
    `Relationship status: ${r.relationshipStatus ?? 'not shared'}`,
    `Prompt answers:\n${prompts}`,
    `How they operate: ${operate || 'not shared'}`,
    '',
    'Generate ONE question for them to answer on their profile.',
    `Focus on: ${focus}`,
    ...(previousQuestion
      ? [
          '',
          `The first question already asked was: ${previousQuestion}`,
          'Generate a COMPLETELY DIFFERENT question — different topic, different angle, different aspect of who they are.',
        ]
      : []),
    '',
    'Rules:',
    "- Specific to THIS person's selections",
    '- Reveals something real about who they are in relationships',
    '- Something only THEY can answer — not generic',
    '- Feels like it came from someone who actually read their profile',
    '- Under 15 words',
    '- No yes/no questions — open ended only',
    '- Warm, thoughtful, intentional tone — not clinical',
    '- Do not reference specific tags by name — infer from them',
    '- Return ONLY the question, nothing else',
  ].join('\n')
}
