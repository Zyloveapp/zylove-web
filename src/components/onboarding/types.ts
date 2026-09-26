import type { AttractedTo, Dealbreaker, GenderIdentity, RelationshipValue, SeekingTrait } from '../../types/profile'
import type { PromptAnswer } from '../../types/dualProfile'
import type { BodyTypePreference, HeightPreference } from '../../types/preferences'

export type IntentChoice = 'spark' | 'play' | 'both'

export interface PhotoDraft {
  id: string
  file: File
  previewUrl: string
}

export interface SeekingDraft {
  heightPreference: HeightPreference
  bodyTypePreference: BodyTypePreference[]
  seekingTraits: SeekingTrait[]
  topValues: RelationshipValue[]
  dealbreakers: Dealbreaker[]
}

export interface OnboardingDraft {
  intent: IntentChoice | null
  displayName: string
  age: string
  genderIdentity: GenderIdentity | null
  genderSelfDescribe: string
  attractedTo: AttractedTo[]
  photos: PhotoDraft[]
  prompts: PromptAnswer[]
  seeking: SeekingDraft
}

export const MIN_AGE = 18
export const MAX_AGE = 99
export const MAX_PHOTOS = 6
export const PROMPT_COUNT = 3
export const PROMPT_MAX_LENGTH = 200
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024 // matches storage.rules

export function parseAge(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw.trim())) return null
  const n = Number(raw)
  return n >= MIN_AGE && n <= MAX_AGE ? n : null
}

// Toggles value in list; when max is set, adding past it is a no-op.
export function toggleIn<T>(list: T[], value: T, max?: number): T[] {
  if (list.includes(value)) return list.filter((v) => v !== value)
  if (max !== undefined && list.length >= max) return list
  return [...list, value]
}

export function includesPlay(intent: IntentChoice | null): boolean {
  return intent === 'play' || intent === 'both'
}
