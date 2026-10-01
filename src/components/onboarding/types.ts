import type {
  AttractedTo,
  BodyType,
  DatingIntent,
  Dealbreaker,
  DrinkingHabit,
  GenderIdentity,
  HabitTag,
  LifestyleTag,
  LoveLanguage,
  OpenTo,
  ParentalCurrent,
  ParentalIntent,
  PersonalityTrait,
  PoliticalView,
  RelationshipStatus,
  RelationshipValue,
  Religion,
  SeekingTrait,
  WeekendVibe,
} from '../../types/profile'

// ─── Go Deeper (web-defined; not in the mobile app yet) ──────────────────────

export type ConflictStyle = 'direct' | 'process_first' | 'avoid' | 'situational'
export type TogethernessStyle = 'entwined' | 'separate_plus_deep' | 'independent' | 'in_between'
export type StressResponse = 'power_through' | 'step_back' | 'talk_it_out' | 'get_quiet'

export const CONFLICT_STYLE_LABELS: Record<ConflictStyle, string> = {
  direct: 'Talks it through right away',
  process_first: 'Takes space, then comes back',
  avoid: 'Avoids if possible',
  situational: 'Depends on the situation',
}

export const TOGETHERNESS_STYLE_LABELS: Record<TogethernessStyle, string> = {
  entwined: 'I love an entwined life',
  separate_plus_deep: 'Independent, but deeply connected',
  independent: 'I need a lot of independence',
  in_between: 'Somewhere in between',
}

export const STRESS_RESPONSE_LABELS: Record<StressResponse, string> = {
  power_through: 'I power through',
  step_back: 'I step back to reset',
  talk_it_out: 'I talk it out',
  get_quiet: 'I get quiet and internal',
}

// ─── Draft ───────────────────────────────────────────────────────────────────

// file is null for a photo that's already uploaded (profile refresh); its
// previewUrl is then the stored download URL rather than an object URL.
export interface PhotoDraft {
  id: string
  file: File | null
  previewUrl: string
}

export function releasePhotoPreview(p: PhotoDraft): void {
  if (p.file) URL.revokeObjectURL(p.previewUrl)
}

export interface HeightFtIn {
  feet: number
  inches: number
}

export interface OnboardingDraft {
  termsAccepted: boolean
  displayName: string
  birthdayRaw: string
  photos: PhotoDraft[]
  genderIdentity: GenderIdentity | null
  genderSelfDescribe: string
  matchableAs: AttractedTo[]
  pronouns: string
  attractedTo: AttractedTo[]
  relationshipStatus: RelationshipStatus | null
  openTo: OpenTo[]
  bodyType: BodyType | null
  height: HeightFtIn
  lifestyleTags: LifestyleTag[]
  habitTags: HabitTag[]
  drinkingHabit: DrinkingHabit | null
  personalityTraits: PersonalityTrait[]
  relationshipValues: RelationshipValue[]
  weekendVibes: WeekendVibe[]
  loveLangGive: LoveLanguage[]
  loveLangReceive: LoveLanguage[]
  religion: Religion | null
  politicalView: PoliticalView | null
  parentalCurrent: ParentalCurrent | null
  parentalIntent: ParentalIntent | null
  seekingHeightNoPreference: boolean
  seekingHeightMin: HeightFtIn
  seekingHeightMax: HeightFtIn
  seekingBodyTypes: BodyType[]
  seekingTraits: SeekingTrait[]
  dealbreakers: Dealbreaker[]
  intent: DatingIntent | null
  radiusMiles: number
  ageMin: number
  ageMax: number
  selectedPromptIds: string[]
  promptAnswers: Record<string, string>
  conflictStyle: ConflictStyle | null
  togethernessStyle: TogethernessStyle | null
  stressResponse: StressResponse | null
  bio: string
  bioGeneratedAt: number | null
}

export const INITIAL_DRAFT: OnboardingDraft = {
  termsAccepted: false,
  displayName: '',
  birthdayRaw: '',
  photos: [],
  genderIdentity: null,
  genderSelfDescribe: '',
  matchableAs: [],
  pronouns: '',
  attractedTo: [],
  relationshipStatus: null,
  openTo: [],
  bodyType: null,
  height: { feet: 5, inches: 6 },
  lifestyleTags: [],
  habitTags: [],
  drinkingHabit: null,
  personalityTraits: [],
  relationshipValues: [],
  weekendVibes: [],
  loveLangGive: [],
  loveLangReceive: [],
  religion: null,
  politicalView: null,
  parentalCurrent: null,
  parentalIntent: null,
  seekingHeightNoPreference: true,
  seekingHeightMin: { feet: 5, inches: 0 },
  seekingHeightMax: { feet: 6, inches: 6 },
  seekingBodyTypes: [],
  seekingTraits: [],
  dealbreakers: [],
  intent: null,
  radiusMiles: 25,
  ageMin: 21,
  ageMax: 45,
  selectedPromptIds: [],
  promptAnswers: {},
  conflictStyle: null,
  togethernessStyle: null,
  stressResponse: null,
  bio: '',
  bioGeneratedAt: null,
}

// ─── Limits ──────────────────────────────────────────────────────────────────

export const MIN_AGE = 18
export const MAX_RANGE_AGE = 80
export const MAX_PHOTOS = 6
// Profile refresh: existing profiles can hold up to Edit Profile's limit.
export const MAX_REFRESH_PHOTOS = 9
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024 // matches storage.rules
export const PROMPT_COUNT = 3
export const MIN_PROMPT_ANSWERS = 2
export const PROMPT_MAX_LENGTH = 200
export const BIO_MAX_LENGTH = 300
export const RADIUS_OPTIONS = [5, 10, 25, 50, 100] as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

export interface Option<T extends string> {
  value: T
  label: string
  description?: string
}

export function toOptions<K extends string, V>(
  record: Record<K, V>,
  label: (v: V) => string,
  description?: (v: V) => string | undefined,
): Option<K>[] {
  return (Object.keys(record) as K[]).map((k) => ({
    value: k,
    label: label(record[k]),
    description: description?.(record[k]),
  }))
}

// Toggles value in list; when max is set, adding past it is a no-op.
export function toggleIn<T>(list: T[], value: T, max?: number): T[] {
  if (list.includes(value)) return list.filter((v) => v !== value)
  if (max !== undefined && list.length >= max) return list
  return [...list, value]
}

// Parses MM/DD/YYYY into an ISO date and whole-years age. Null if not a real date.
export function parseBirthday(raw: string): { iso: string; age: number } | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw)
  if (!m) return null
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null

  const today = new Date()
  if (date > today || year < 1900) return null
  let age = today.getFullYear() - year
  if (today.getMonth() < month - 1 || (today.getMonth() === month - 1 && today.getDate() < day)) age--

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { iso, age }
}

// Formats digits as MM/DD/YYYY while typing.
export function formatBirthdayInput(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8)
  if (d.length <= 2) return d
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`
}

export function heightToInches(h: HeightFtIn): number {
  return h.feet * 12 + h.inches
}

export function answeredPromptCount(d: OnboardingDraft): number {
  return d.selectedPromptIds.filter((id) => (d.promptAnswers[id] ?? '').trim().length > 0).length
}

export function includesPlay(intent: DatingIntent | null): boolean {
  return intent === 'play' || intent === 'open'
}

export interface StepProps {
  draft: OnboardingDraft
  update: (patch: Partial<OnboardingDraft>) => void
}
