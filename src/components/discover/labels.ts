import {
  BODY_TYPE_LABELS,
  CONFLICT_STYLE_LABELS,
  DEALBREAKER_LABELS,
  GENDER_LABELS,
  HABIT_TAG_LABELS,
  LIFESTYLE_TAG_LABELS,
  LOVE_LANGUAGE_LABELS,
  OPEN_TO_LABELS,
  PARENTAL_CURRENT_LABELS,
  PARENTAL_INTENT_LABELS,
  PARENTAL_STATUS_LABELS,
  PERSONALITY_TRAIT_LABELS,
  PLAY_PROMPTS as LEGACY_PLAY_PROMPTS,
  RELATIONSHIP_STATUS_LABELS,
  RELATIONSHIP_VALUE_LABELS,
  SEEKING_TRAIT_LABELS,
  SPARK_PROMPTS as LEGACY_SPARK_PROMPTS,
  STRESS_RESPONSE_LABELS,
  TOGETHERNESS_STYLE_LABELS,
  UNIVERSAL_PROMPTS,
  WEEKEND_VIBE_LABELS,
} from '../../types/profile'
import { PLAY_PROMPT_BANK, SPARK_PROMPT_BANK } from '../../types/dualProfile'
import type { DiscoverProfile } from '../../services/discover'

// Profiles are written by several app versions, so stored keys may not exist
// in today's label maps. Unknown keys fall back to a readable version of the key.
function lookup<V>(record: object, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? (record as Record<string, V>)[key] : undefined
}

function humanize(key: string): string {
  const s = key.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function labelOf(record: object, key: string): string {
  const v = lookup<unknown>(record, key)
  if (typeof v === 'string') return v
  if (typeof v === 'object' && v !== null && 'label' in v && typeof v.label === 'string') return v.label
  return humanize(key)
}

export const personalityLabel = (k: string) => labelOf(PERSONALITY_TRAIT_LABELS, k)
export const valueLabel = (k: string) => labelOf(RELATIONSHIP_VALUE_LABELS, k)
export const loveLanguageLabel = (k: string) => labelOf(LOVE_LANGUAGE_LABELS, k)

export const openToLabel = (k: string) => labelOf(OPEN_TO_LABELS, k)
export const dealbreakerLabel = (k: string) => labelOf(DEALBREAKER_LABELS, k)
export const seekingTraitLabel = (k: string) => labelOf(SEEKING_TRAIT_LABELS, k)
export const genderLabel = (k: string) => labelOf(GENDER_LABELS, k)
// genderIdentity is a string from Spark onboarding, an array from Play.
export function profileGenderLabel(p: DiscoverProfile): string | null {
  const raw: unknown = p.genderIdentity
  const g = Array.isArray(raw) ? raw[0] : raw
  if (typeof g !== 'string' || !g) return null
  return g === 'self_describe' ? p.genderSelfDescribe?.trim() || null : genderLabel(g)
}

// Shown under the name. §4.A2: the server-built genderLine — the only gender
// anyone else can read (functions/src/genderLine.ts): e.g. "Trans woman ·
// she/her", just "she/her" (man / woman are implied unless the owner shows
// them), nothing when hidden. The owner's own preview shows the same line.
export function identityLine(p: DiscoverProfile): string | null {
  return typeof p.genderLine === 'string' && p.genderLine.trim() ? p.genderLine.trim() : null
}

// §4.A2: man / woman are left off the profile unless the owner shows them;
// other identities are shown unless the owner hides them.
export function impliedGender(genderIdentity: unknown): boolean {
  const g = Array.isArray(genderIdentity) ? genderIdentity[0] : genderIdentity
  return g === 'man' || g === 'woman'
}

export const relationshipStatusLabel = (k: string) => labelOf(RELATIONSHIP_STATUS_LABELS, k)

function emojiLabel(record: object, k: string): string {
  const v = lookup<{ label: string; emoji: string }>(record, k)
  return v ? `${v.emoji} ${v.label}` : humanize(k)
}

export const lifestyleLabel = (k: string) => emojiLabel(LIFESTYLE_TAG_LABELS, k)
export const habitLabel = (k: string) => emojiLabel(HABIT_TAG_LABELS, k)
export const weekendLabel = (k: string) => emojiLabel(WEEKEND_VIBE_LABELS, k)
export const bodyTypeLabel = (k: string) => emojiLabel(BODY_TYPE_LABELS, k)

const PROMPT_TEXT = new Map<string, string>(
  [...SPARK_PROMPT_BANK, ...PLAY_PROMPT_BANK, ...UNIVERSAL_PROMPTS, ...LEGACY_SPARK_PROMPTS, ...LEGACY_PLAY_PROMPTS].map(
    (p) => [p.id, p.text],
  ),
)

// Mobile stores its AI-written "just for you" question under 'dynamic'
// without the question text.
// dynamicText: the profile's own dynamicPrompt, when it has one.
export function promptQuestion(id: string, dynamicText?: unknown): string {
  if (id === 'dynamic') return typeof dynamicText === 'string' && dynamicText ? dynamicText : 'A question just for them'
  return PROMPT_TEXT.get(id) ?? humanize(id)
}

export function goDeeperRows(p: DiscoverProfile): { label: string; value: string }[] {
  return [
    p.conflictStyle && { label: 'Conflict', value: labelOf(CONFLICT_STYLE_LABELS, p.conflictStyle) },
    p.togethernessStyle && { label: 'Together time', value: labelOf(TOGETHERNESS_STYLE_LABELS, p.togethernessStyle) },
    p.stressResponse && { label: 'Under stress', value: labelOf(STRESS_RESPONSE_LABELS, p.stressResponse) },
  ].filter((r): r is { label: string; value: string } => Boolean(r))
}

export function kidsDetail(p: DiscoverProfile): string | null {
  if (p.parentalCurrent) {
    const current = labelOf(PARENTAL_CURRENT_LABELS, p.parentalCurrent)
    return p.parentalIntent ? `${current} · ${labelOf(PARENTAL_INTENT_LABELS, p.parentalIntent)}` : current
  }
  // Older profiles only have the single legacy field.
  return p.parentalStatus && p.parentalStatus !== 'prefer_not_to_say'
    ? labelOf(PARENTAL_STATUS_LABELS, p.parentalStatus)
    : null
}

export function lifeDetails(p: DiscoverProfile): { label: string; value: string }[] {
  const kids = kidsDetail(p)
  const skip = (k: string | undefined) => !k || k === 'prefer_not_to_say'
  return [
    !skip(p.relationshipStatus) && {
      label: 'Relationship status',
      value: labelOf(RELATIONSHIP_STATUS_LABELS, p.relationshipStatus ?? ''),
    },
    kids && { label: 'Kids', value: kids },
    // Religion and politics are never shown to other members (F-018): they're
    // only used for matching.
  ].filter((r): r is { label: string; value: string } => Boolean(r))
}
