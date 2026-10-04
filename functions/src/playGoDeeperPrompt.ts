// Play Go Deeper — one personal question per call, written from the user's
// Play onboarding answers. Also home to the "about you" / "my type" / Go
// Deeper request parsing the Play bio shares.

import {
  PLAY_NON_NEGOTIABLE_LABELS,
  PLAY_TAG_LABELS,
  SPICE_META,
  type PlayInterestTag,
  type PlayNonNegotiable,
  type SpiceLevel,
} from './shared/dualProfile'
import {
  PLAY_BODY_HAIR_LABELS,
  PLAY_BODY_TYPE_LABELS,
  PLAY_ENERGY_LABELS,
  PLAY_GROOMING_LABELS,
  formatHeightCm,
  parseTypePreferences,
  typePreferenceLabels,
} from './shared/playDescriptors'

const MAX_QUESTION = 200
const MAX_ANSWER = 300
const MAX_ANSWERS = 8
const MIN_HEIGHT_CM = 120
const MAX_HEIGHT_CM = 240

type Json = Record<string, unknown>

function has<T extends object>(record: T, key: unknown): key is keyof T {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(record, key)
}

// Label for a known key; "Prefer not to say" and anything unknown → null.
function label(record: Record<string, string>, v: unknown): string | null {
  return has(record, v) && v !== 'prefer_not_to_say' ? record[v] : null
}

export interface PlayAbout {
  bodyType: string | null
  height: string | null
  bodyHair: string | null
  grooming: string | null
  energy: string | null
  // "Build: Athletic"-style lines, "Doesn't matter" left out.
  typePreferences: string[]
}

export function parsePlayAbout(d: Json): PlayAbout {
  const cm = d.playHeight
  return {
    bodyType: label(PLAY_BODY_TYPE_LABELS, d.playBodyType),
    height:
      typeof cm === 'number' && cm >= MIN_HEIGHT_CM && cm <= MAX_HEIGHT_CM ? formatHeightCm(cm) : null,
    bodyHair: label(PLAY_BODY_HAIR_LABELS, d.playBodyHair),
    grooming: label(PLAY_GROOMING_LABELS, d.playGrooming),
    energy: label(PLAY_ENERGY_LABELS, d.playEnergy),
    typePreferences: typePreferenceLabels(parseTypePreferences(d.typePreferences)),
  }
}

// "Average, 5'10", some body hair, Stubble, Calm energy" — only what's set.
export function aboutLine(a: PlayAbout): string {
  return [
    a.bodyType,
    a.height,
    a.bodyHair && `${a.bodyHair.toLowerCase()} body hair`,
    a.grooming,
    a.energy && `${a.energy} energy`,
  ]
    .filter(Boolean)
    .join(', ')
}

// [{ question, answer }] with both non-empty, trimmed and capped.
export function parseQuestionAnswers(v: unknown): { question: string; answer: string }[] {
  if (!Array.isArray(v)) return []
  return v
    .map((p) => [(p as Json)?.question, (p as Json)?.answer])
    .filter((e): e is [string, string] => typeof e[0] === 'string' && typeof e[1] === 'string')
    .map(([q, a]) => ({ question: q.trim().slice(0, MAX_QUESTION), answer: a.trim().slice(0, MAX_ANSWER) }))
    .filter((p) => p.question && p.answer)
    .slice(0, MAX_ANSWERS)
}

export function qaBlocks(list: { question: string; answer: string }[]): string {
  return list.map((p) => `Q: ${p.question}\nA: ${p.answer}`).join('\n\n')
}

export interface PlayGoDeeperRequest {
  spiceLevel: SpiceLevel | null
  arrangement: PlayInterestTag[]
  dynamic: PlayInterestTag[]
  vibe: PlayInterestTag[]
  acts: PlayInterestTag[]
  nonNegotiables: PlayNonNegotiable[]
  about: PlayAbout
  existingPromptAnswers: { question: string; answer: string }[]
}

function tags(d: Json, field: string, category: string): PlayInterestTag[] {
  const v = d[field]
  if (!Array.isArray(v)) return []
  return v.filter((t): t is PlayInterestTag => has(PLAY_TAG_LABELS, t) && PLAY_TAG_LABELS[t].category === category)
}

// Labels and descriptions come from the server's own tables, so the
// client's spiceDescription is ignored.
export function parsePlayGoDeeperRequest(raw: unknown): PlayGoDeeperRequest {
  const d: Json = typeof raw === 'object' && raw !== null ? (raw as Json) : {}
  const nonNegotiables = Array.isArray(d.nonNegotiables) ? d.nonNegotiables : []
  return {
    spiceLevel: has(SPICE_META, d.spiceLevel) ? d.spiceLevel : null,
    arrangement: tags(d, 'arrangementTags', 'arrangement'),
    dynamic: tags(d, 'dynamicTags', 'dynamic'),
    vibe: tags(d, 'vibeTags', 'vibe'),
    acts: tags(d, 'actsTags', 'acts'),
    nonNegotiables: nonNegotiables.filter((k): k is PlayNonNegotiable => has(PLAY_NON_NEGOTIABLE_LABELS, k)),
    about: parsePlayAbout(d),
    existingPromptAnswers: parseQuestionAnswers(d.existingPromptAnswers),
  }
}

const tagLabels = (list: PlayInterestTag[]) => list.map((t) => PLAY_TAG_LABELS[t].label).join(', ')

// The two calls look at different sides of the person.
export const GO_DEEPER_FOCUS = [
  'what they bring, their energy, their style',
  "what they're looking for, what a good experience looks like for them, or something unexpected about them in this space",
] as const

// Lines with nothing to say are dropped rather than sent as blanks. The
// second call gets the first question so it can steer away from it.
export function buildPlayGoDeeperPrompt(
  r: PlayGoDeeperRequest,
  { focus, previousQuestion }: { focus: string; previousQuestion?: string },
): string {
  const spice = r.spiceLevel ? SPICE_META[r.spiceLevel] : null
  const about = aboutLine(r.about)
  const existing = qaBlocks(r.existingPromptAnswers)
  const facts = [
    spice ? `Spice level: ${spice.label} — ${spice.description}` : '',
    r.arrangement.length ? `Here for: ${tagLabels(r.arrangement)}` : '',
    r.dynamic.length ? `Their dynamic: ${tagLabels(r.dynamic)}` : '',
    r.vibe.length ? `Their vibe: ${tagLabels(r.vibe)}` : '',
    r.acts.length ? `Into: ${tagLabels(r.acts)}` : '',
    r.nonNegotiables.length
      ? `Non-negotiables: ${r.nonNegotiables.map((k) => PLAY_NON_NEGOTIABLE_LABELS[k]).join(', ')}`
      : '',
    about ? `About them: ${about}` : '',
    r.about.typePreferences.length ? `Their type: ${r.about.typePreferences.join(', ')}` : '',
    existing ? `What they've already shared:\n${existing}` : '',
  ].filter(Boolean)

  return [
    'You are generating a personal Go Deeper question for an adult dating profile on Zylove Play.',
    '',
    'The user has shared the following about themselves:',
    '',
    ...facts,
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
    "- The question must be specific to THIS person's selections",
    '- It should reveal something real about who they are in this space',
    '- It should be something only THEY can answer — not generic',
    '- It should feel like it came from someone who actually read their profile',
    '- Keep it under 15 words',
    '- No yes/no questions — open ended only',
    '- Tasteful but adult in tone',
    '- Do not reference specific tags by name — infer from them',
    '- Cover a different aspect of their personality than their non-negotiables or trust — look at their dynamic, their vibe, their arrangement, their energy',
    "- The question should surprise them slightly — something they haven't been asked before",
    '- Never ask about trust, safety or limits — those are covered by their non-negotiables',
    '- Return ONLY the question, nothing else',
  ].join('\n')
}

// One clean question: first line, no surrounding quotes or "Q:" label.
export function cleanGoDeeperQuestion(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  const unquote = (t: string) => t.trim().replace(/^["“']+|["”']+$/g, '').trim()
  return unquote(unquote(line).replace(/^(?:Q|Question)\s*:\s*/i, '')).slice(0, MAX_QUESTION)
}
