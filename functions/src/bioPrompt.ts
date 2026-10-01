// Port of generateBio() from the mobile app's app/onboarding/index.tsx.
// Enum values arrive as profile.ts keys and are turned into the same labels
// and descriptions the mobile prompt uses. Unknown keys are dropped and free
// text is length-capped, since callers can send anything.

import {
  BODY_TYPE_LABELS,
  DEALBREAKER_LABELS,
  DRINKING_HABIT_LABELS,
  GENDER_LABELS,
  HABIT_TAG_LABELS,
  LIFESTYLE_TAG_LABELS,
  LOVE_LANGUAGE_LABELS,
  OPEN_TO_LABELS,
  PARENTAL_CURRENT_LABELS,
  PARENTAL_INTENT_LABELS,
  PERSONALITY_TRAIT_LABELS,
  POLITICAL_VIEW_LABELS,
  RELATIONSHIP_STATUS_LABELS,
  RELATIONSHIP_VALUE_LABELS,
  RELIGION_LABELS,
  SEEKING_TRAIT_LABELS,
  WEEKEND_VIBE_LABELS,
  cmToFeetInches,
} from './shared/profile'
import { SPARK_PROMPT_BANK } from './shared/dualProfile'
import { CONFLICT_STYLE_LABELS, STRESS_RESPONSE_LABELS, TOGETHERNESS_STYLE_LABELS } from './shared/goDeeper'

export interface BioRequest {
  displayName: string
  genderIdentity: string | null
  pronouns: string | null
  age: number | null
  heightCm: number | null
  bodyType: string | null
  drinkingHabit: string | null
  religion: string | null
  politicalView: string | null
  relationshipStatus: string | null
  openTo: string[]
  lifestyleTags: string[]
  habitTags: string[]
  personalityTraits: string[]
  relationshipValues: string[]
  weekendVibes: string[]
  loveLangGive: string[]
  loveLangReceive: string[]
  parentalCurrent: string | null
  parentalIntent: string | null
  seekingTraits: string[]
  dealbreakers: string[]
  sparkPromptAnswers: Record<string, string>
  conflictStyle: string | null
  togethernessStyle: string | null
  stressResponse: string | null
  intent: string | null
}

const MAX_NAME = 40
const MAX_SHORT_TEXT = 40
const MAX_ANSWER = 200
const MAX_LIST = 25

type Json = Record<string, unknown>

function str(data: Json, key: string, max: number): string | null {
  const v = data[key]
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}

function num(data: Json, key: string): number | null {
  const v = data[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// Keeps only values that are known keys of the given label map.
function key(data: Json, name: string, known: object): string | null {
  const v = data[name]
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(known, v) ? v : null
}

function keys(data: Json, name: string, known: object): string[] {
  const v = data[name]
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string' && Object.prototype.hasOwnProperty.call(known, x))
    .slice(0, MAX_LIST)
}

const PROMPT_TEXT = new Map(SPARK_PROMPT_BANK.map((p) => [p.id, p.text]))

function answers(data: Json): Record<string, string> {
  const v = data.sparkPromptAnswers
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [id, answer] of Object.entries(v)) {
    if (PROMPT_TEXT.has(id) && typeof answer === 'string' && answer.trim()) {
      out[id] = answer.trim().slice(0, MAX_ANSWER)
    }
  }
  return out
}

export function parseBioRequest(raw: unknown): BioRequest {
  const d: Json = typeof raw === 'object' && raw !== null ? (raw as Json) : {}
  return {
    displayName: str(d, 'displayName', MAX_NAME) ?? '',
    genderIdentity: key(d, 'genderIdentity', GENDER_LABELS),
    pronouns: str(d, 'pronouns', MAX_SHORT_TEXT),
    age: num(d, 'age'),
    heightCm: num(d, 'heightCm'),
    bodyType: key(d, 'bodyType', BODY_TYPE_LABELS),
    drinkingHabit: key(d, 'drinkingHabit', DRINKING_HABIT_LABELS),
    religion: key(d, 'religion', RELIGION_LABELS),
    politicalView: key(d, 'politicalView', POLITICAL_VIEW_LABELS),
    relationshipStatus: key(d, 'relationshipStatus', RELATIONSHIP_STATUS_LABELS),
    openTo: keys(d, 'openTo', OPEN_TO_LABELS),
    lifestyleTags: keys(d, 'lifestyleTags', LIFESTYLE_TAG_LABELS),
    habitTags: keys(d, 'habitTags', HABIT_TAG_LABELS),
    personalityTraits: keys(d, 'personalityTraits', PERSONALITY_TRAIT_LABELS),
    relationshipValues: keys(d, 'relationshipValues', RELATIONSHIP_VALUE_LABELS),
    weekendVibes: keys(d, 'weekendVibes', WEEKEND_VIBE_LABELS),
    loveLangGive: keys(d, 'loveLangGive', LOVE_LANGUAGE_LABELS),
    loveLangReceive: keys(d, 'loveLangReceive', LOVE_LANGUAGE_LABELS),
    parentalCurrent: key(d, 'parentalCurrent', PARENTAL_CURRENT_LABELS),
    parentalIntent: key(d, 'parentalIntent', PARENTAL_INTENT_LABELS),
    seekingTraits: keys(d, 'seekingTraits', SEEKING_TRAIT_LABELS),
    dealbreakers: keys(d, 'dealbreakers', DEALBREAKER_LABELS),
    sparkPromptAnswers: answers(d),
    conflictStyle: key(d, 'conflictStyle', CONFLICT_STYLE_LABELS),
    togethernessStyle: key(d, 'togethernessStyle', TOGETHERNESS_STYLE_LABELS),
    stressResponse: key(d, 'stressResponse', STRESS_RESPONSE_LABELS),
    intent: typeof d.intent === 'string' && ['spark', 'play', 'open'].includes(d.intent) ? d.intent : null,
  }
}

// Lookup helper: value is already validated as a key of the record.
function label<V>(record: Record<string, V>, k: string | null): V | null {
  return k === null ? null : (record[k] ?? null)
}

export function buildBioPrompt(s: BioRequest): string {
  const lifestyle = s.lifestyleTags.map((t) => LIFESTYLE_TAG_LABELS[t as keyof typeof LIFESTYLE_TAG_LABELS].description).join(' ')
  const habits = s.habitTags.map((t) => HABIT_TAG_LABELS[t as keyof typeof HABIT_TAG_LABELS].label).join(', ')
  const traits = s.personalityTraits.map((t) => PERSONALITY_TRAIT_LABELS[t as keyof typeof PERSONALITY_TRAIT_LABELS]).join(', ')
  const values = s.relationshipValues.map((v) => RELATIONSHIP_VALUE_LABELS[v as keyof typeof RELATIONSHIP_VALUE_LABELS]).join(', ')
  const weekend =
    s.weekendVibes.map((v) => WEEKEND_VIBE_LABELS[v as keyof typeof WEEKEND_VIBE_LABELS].description).join(' ') ||
    'a mix of things'
  const give = s.loveLangGive.map((l) => LOVE_LANGUAGE_LABELS[l as keyof typeof LOVE_LANGUAGE_LABELS].label).join(', ')
  const receive = s.loveLangReceive.map((l) => LOVE_LANGUAGE_LABELS[l as keyof typeof LOVE_LANGUAGE_LABELS].label).join(', ')
  const kidsLine = (() => {
    if (!s.parentalCurrent) return undefined
    const currentLabel = s.parentalCurrent === 'has_kids' ? 'Has kids' : 'No kids'
    const intentLabels: Record<string, string> = {
      wants_first: 'wants them',
      wants_more: 'open to more',
      open_to_more: 'open to more, not actively seeking',
      doesnt_want_any: "doesn't want kids",
      doesnt_want_more: 'family feels complete',
      undecided: 'undecided',
    }
    const intentPart = s.parentalIntent ? ` · ${intentLabels[s.parentalIntent] ?? s.parentalIntent}` : ''
    return `${currentLabel}${intentPart}`
  })()
  const drinking = label<{ label: string }>(DRINKING_HABIT_LABELS, s.drinkingHabit)?.label.toLowerCase() ?? null
  const religion = label<string>(RELIGION_LABELS, s.religion)
  const politics = label<{ label: string }>(POLITICAL_VIEW_LABELS, s.politicalView)?.label ?? null
  const bodyType = label<{ label: string }>(BODY_TYPE_LABELS, s.bodyType)?.label ?? null
  const heightStr = s.heightCm !== null ? cmToFeetInches(s.heightCm) : null
  // Mobile falls back to the raw key; "Self-describe" isn't a gender, so skip it.
  const gender = s.genderIdentity && s.genderIdentity !== 'self_describe' ? label<string>(GENDER_LABELS, s.genderIdentity) : null
  const relStatus = label<{ label: string }>(RELATIONSHIP_STATUS_LABELS, s.relationshipStatus)?.label ?? null
  const openToStr = s.openTo.map((o) => OPEN_TO_LABELS[o as keyof typeof OPEN_TO_LABELS].label).join(', ')
  const seekingStr = s.seekingTraits.map((t) => SEEKING_TRAIT_LABELS[t as keyof typeof SEEKING_TRAIT_LABELS]).join(', ')
  const dealbreakers = s.dealbreakers.map((d) => DEALBREAKER_LABELS[d as keyof typeof DEALBREAKER_LABELS]).join(', ')
  const conflict = label<string>(CONFLICT_STYLE_LABELS, s.conflictStyle)
  const togetherness = label<string>(TOGETHERNESS_STYLE_LABELS, s.togethernessStyle)
  const stress = label<string>(STRESS_RESPONSE_LABELS, s.stressResponse)

  const intentLine =
    s.intent === 'spark'
      ? "Looking for something real and meaningful — not interested in wasting anyone's time"
      : s.intent === 'play'
        ? 'Honest about being here for fun — no games, just good energy'
        : 'Open to connection — labels can come later'

  const promptText = Object.entries(s.sparkPromptAnswers)
    .map(([id, ans]) => `Q: ${PROMPT_TEXT.get(id) ?? id}\nA: ${ans}`)
    .join('\n\n')

  const lines = [
    'Write a Spark mode dating profile bio using ALL of the information below.',
    'This bio should feel specific, human, and completely unlike a template.',
    'Do not list facts — weave them into a voice.',
    '',
    '── WHO THEY ARE ──',
    `Name: ${s.displayName}`,
    gender ? `Gender: ${gender}` : '',
    s.pronouns ? `Pronouns: ${s.pronouns}` : '',
    heightStr ? `Height: ${heightStr}` : '',
    bodyType ? `Body type: ${bodyType}` : '',
    drinking ? `Drinking: ${drinking}` : '',
    religion ? `Faith / religion: ${religion}` : '',
    politics ? `Political views: ${politics}` : '',
    kidsLine ? `Kids situation: ${kidsLine}` : '',
    '',
    '── HOW THEY SHOW UP ──',
    traits ? `Personality: ${traits}` : '',
    lifestyle ? `Lifestyle: ${lifestyle}` : '',
    habits ? `Habits & interests: ${habits}` : '',
    weekend ? `Perfect weekend: ${weekend}` : '',
    give ? `Shows love by: ${give}` : '',
    receive ? `Feels loved when: ${receive}` : '',
    values ? `Values in a relationship: ${values}` : '',
    // Web addition: Go Deeper answers (not in the mobile prompt).
    conflict ? `When conflict comes up: ${conflict}` : '',
    togetherness ? `In a relationship: ${togetherness}` : '',
    stress ? `When stressed: ${stress}` : '',
    '',
    '── WHAT THEY WANT ──',
    `Intent: ${intentLine}`,
    relStatus ? `Relationship status: ${relStatus}` : '',
    openToStr ? `Open to: ${openToStr}` : '',
    seekingStr ? `Looking for someone who is: ${seekingStr}` : '',
    dealbreakers ? `Dealbreakers: ${dealbreakers}` : '',
    '',
    '── THEIR OWN WORDS ──',
    promptText || 'none provided',
    '',
    '── RULES ──',
    '- 2–4 sentences, max 280 characters (hard limit 300)',
    '- First person, warm, confident, and specific to THIS person',
    '- Let their actual voice come through — use their prompt answers as the primary tone guide',
    '- Weave in who they are and what they want without sounding like a resume',
    '- No clichés. Never: "I love to laugh", "partner in crime", "fluent in sarcasm", "dog mom/dad"',
    '- Do not mention every fact — choose the most interesting combination',
    '- End with something that makes the right person want to reach out',
    '- Return ONLY the bio text, nothing else',
  ]

  return lines.filter(Boolean).join('\n')
}
