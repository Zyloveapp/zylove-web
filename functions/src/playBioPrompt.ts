// Play bio prompt — the template from the mobile app's
// src/services/bioGenerator.ts generatePlayBio(), moved server-side so the
// Anthropic key never reaches a browser. Keep the wording in sync with mobile.

import {
  PLAY_NON_NEGOTIABLE_LABELS,
  PLAY_PROMPT_BANK,
  PLAY_TAG_LABELS,
  SPICE_META,
  type PlayInterestTag,
  type PlayNonNegotiable,
  type SpiceLevel,
} from './shared/dualProfile'
import { ATTRACTED_TO_LABELS, GENDER_LABELS } from './shared/profile'

const MAX_ANSWER = 300
const MAX_ANSWERS = 6
const MAX_DYNAMIC_PROMPT = 300

type Json = Record<string, unknown>

export interface PlayBioRequest {
  spiceLevel: SpiceLevel | null
  arrangement: PlayInterestTag[]
  acts: PlayInterestTag[]
  dynamic: PlayInterestTag[]
  vibe: PlayInterestTag[]
  place: PlayInterestTag[]
  nonNegotiables: PlayNonNegotiable[]
  promptAnswers: { promptId: string; answer: string }[]
  dynamicPrompt: string | null
  genderIdentity: string[]
  attractedTo: string[]
}

function has<T extends object>(record: T, key: unknown): key is keyof T {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(record, key)
}

// Only tags that exist and belong to the named category.
function tags(d: Json, field: string, category: string): PlayInterestTag[] {
  const v = d[field]
  if (!Array.isArray(v)) return []
  return v.filter((t): t is PlayInterestTag => has(PLAY_TAG_LABELS, t) && PLAY_TAG_LABELS[t].category === category)
}

// Known keys become their labels; anything else is dropped.
function labels(v: unknown, record: Record<string, string>): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
  return list.filter((k): k is string => has(record, k)).map((k) => record[k])
}

function answers(d: Json): { promptId: string; answer: string }[] {
  const v = d.promptAnswers
  const entries: [unknown, unknown][] = Array.isArray(v)
    ? v.map((p) => [(p as Json)?.promptId, (p as Json)?.answer])
    : typeof v === 'object' && v !== null
      ? Object.entries(v)
      : []
  return entries
    .filter((e): e is [string, string] => typeof e[0] === 'string' && typeof e[1] === 'string' && e[1].trim() !== '')
    .slice(0, MAX_ANSWERS)
    .map(([promptId, answer]) => ({ promptId, answer: answer.trim().slice(0, MAX_ANSWER) }))
}

export function parsePlayBioRequest(raw: unknown): PlayBioRequest {
  const d: Json = typeof raw === 'object' && raw !== null ? (raw as Json) : {}
  const nonNegotiables = Array.isArray(d.nonNegotiables) ? d.nonNegotiables : []
  return {
    spiceLevel: has(SPICE_META, d.spiceLevel) ? d.spiceLevel : null,
    arrangement: tags(d, 'arrangement', 'arrangement'),
    acts: tags(d, 'acts', 'acts'),
    dynamic: tags(d, 'dynamic', 'dynamic'),
    vibe: tags(d, 'vibe', 'vibe'),
    place: tags(d, 'place', 'place'),
    nonNegotiables: nonNegotiables.filter((k): k is PlayNonNegotiable => has(PLAY_NON_NEGOTIABLE_LABELS, k)),
    promptAnswers: answers(d),
    dynamicPrompt:
      typeof d.dynamicPrompt === 'string' && d.dynamicPrompt.trim() ? d.dynamicPrompt.trim().slice(0, MAX_DYNAMIC_PROMPT) : null,
    genderIdentity: labels(d.genderIdentity, GENDER_LABELS),
    attractedTo: labels(d.attractedTo, ATTRACTED_TO_LABELS),
  }
}

const tagLabels = (list: PlayInterestTag[]) => list.map((t) => PLAY_TAG_LABELS[t].label).join(', ')

// Web Play onboarding has no orientation step, so that line never appears;
// gender and attraction are the root profile's values, sent as labels.
export function buildPlayBioPrompt(r: PlayBioRequest): string {
  const spiceMeta = r.spiceLevel ? SPICE_META[r.spiceLevel] : null
  const arrangement = tagLabels(r.arrangement)
  const acts = tagLabels(r.acts)
  const dynamic = tagLabels(r.dynamic)
  const vibe = tagLabels(r.vibe)
  const place = tagLabels(r.place)
  const nonNegotiables = r.nonNegotiables.map((k) => PLAY_NON_NEGOTIABLE_LABELS[k]).join(', ')
  const genderStr = r.genderIdentity.join(' ')
  const attractedToStr = r.attractedTo.join(', ')

  const promptText = r.promptAnswers
    .map((pa) => {
      if (pa.promptId === 'dynamic') {
        return `Q: ${r.dynamicPrompt || 'Something about you in this space'}\nA: ${pa.answer}`
      }
      const prompt = PLAY_PROMPT_BANK.find((p) => p.id === pa.promptId)
      return `Q: ${prompt?.text ?? pa.promptId}\nA: ${pa.answer}`
    })
    .join('\n\n')

  // Same construction as mobile: empty strings (including the spacer lines)
  // are filtered out before joining.
  return [
    'Write a Play mode dating profile bio using ALL of the information below.',
    'Play mode is an adult platform for people who are honest about what they want.',
    'This bio should feel specific, confident, and completely unlike a template.',
    'Do not list facts — write in a voice that sounds like this exact person.',
    '',
    '── WHO THEY ARE ──',
    genderStr ? `Gender: ${genderStr}` : '',
    attractedToStr ? `Attracted to: ${attractedToStr}` : '',
    spiceMeta ? `Spice level: ${spiceMeta.label} — ${spiceMeta.description}` : '',
    '',
    '── WHAT THEY WANT ──',
    arrangement ? `Here for: ${arrangement}` : '',
    '',
    '── NON-NEGOTIABLES ──',
    nonNegotiables ? `What they need from any connection: ${nonNegotiables}` : '',
    '',
    '── WHAT THEY ARE INTO ──',
    acts ? `Into: ${acts}` : '',
    dynamic ? `Style / dynamic: ${dynamic}` : '',
    '',
    '── HOW THEY SHOW UP ──',
    vibe ? `Their vibe: ${vibe}` : '',
    place ? `Where they play: ${place}` : '',
    '',
    '── THEIR OWN WORDS ──',
    promptText || 'none provided',
    '',
    '── RULES ──',
    '- Maximum 300 characters',
    '- Confident, direct, adult tone — tasteful but honest',
    '- First person, no quotes around the bio',
    '- No emojis',
    '- Let the prompt answers set the voice — they are the most important input',
    '- Their spice level and dynamic selections should be felt in the tone, not stated explicitly',
    '- Do not mention every selection — choose the combination that paints the most compelling picture',
    '- Someone with "High chemistry only" and "Connection first" should sound completely different from someone with "Purely physical" and "No strings"',
    '- No clichés. Never: "drama free", "good vibes only", "fluent in sarcasm"',
    '- Do not invent or assume details not explicitly provided in the profile data. Only reference facts given above.',
    '- End with something that makes the right person want to reach out',
    '- Return ONLY the bio text, nothing else',
  ]
    .filter(Boolean)
    .join('\n')
}
