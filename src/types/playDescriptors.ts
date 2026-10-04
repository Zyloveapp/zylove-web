// Play-only self-description ("A little about you") and type preferences
// ("My type in this space"). Mirrored verbatim in
// functions/src/shared/playDescriptors.ts — keep the two in sync.

export type PlayBodyType =
  | 'slim'
  | 'athletic'
  | 'average'
  | 'curvy'
  | 'full_figured'
  | 'muscular'
  | 'soft'
  | 'prefer_not_to_say'
export type PlayBodyHair = 'none' | 'light' | 'some' | 'natural' | 'heavy' | 'prefer_not_to_say'
export type PlayGrooming = 'clean_cut' | 'stubble' | 'bearded' | 'well_groomed' | 'natural' | 'prefer_not_to_say'
export type PlayEnergy = 'quiet_intensity' | 'calm' | 'passionate' | 'wild' | 'playful' | 'intense' | 'prefer_not_to_say'

export const PLAY_BODY_TYPE_LABELS: Record<PlayBodyType, string> = {
  slim: 'Slim',
  athletic: 'Athletic',
  average: 'Average',
  curvy: 'Curvy',
  full_figured: 'Full-figured',
  muscular: 'Muscular',
  soft: 'Soft',
  prefer_not_to_say: 'Prefer not to say',
}

export const PLAY_BODY_HAIR_LABELS: Record<PlayBodyHair, string> = {
  none: 'None',
  light: 'Light',
  some: 'Some',
  natural: 'Natural',
  heavy: 'Heavy',
  prefer_not_to_say: 'Prefer not to say',
}

export const PLAY_GROOMING_LABELS: Record<PlayGrooming, string> = {
  clean_cut: 'Clean cut',
  stubble: 'Stubble',
  bearded: 'Bearded',
  well_groomed: 'Well groomed',
  natural: 'Natural',
  prefer_not_to_say: 'Prefer not to say',
}

export const PLAY_ENERGY_LABELS: Record<PlayEnergy, string> = {
  quiet_intensity: 'Quiet intensity',
  calm: 'Calm',
  passionate: 'Passionate',
  wild: 'Wild',
  playful: 'Playful',
  intense: 'Intense',
  prefer_not_to_say: 'Prefer not to say',
}

// ─── Type preferences ────────────────────────────────────────────────────────
// Every category ends in 'doesnt_matter', which counts as no preference.

export type TypeBuild = Exclude<PlayBodyType, 'prefer_not_to_say'> | 'doesnt_matter'
export type TypeHeight = 'shorter' | 'similar' | 'taller' | 'much_taller' | 'doesnt_matter'
export type TypeBodyHair = 'smooth' | 'some' | 'natural' | 'doesnt_matter'
export type TypeGrooming = 'clean_cut' | 'stubble' | 'bearded' | 'natural' | 'doesnt_matter'
export type TypeEnergy = 'quiet' | 'calm' | 'passionate' | 'intense' | 'playful' | 'wild' | 'doesnt_matter'

// Saved with all five keys; null = not answered.
export interface TypePreferences {
  build: TypeBuild | null
  height: TypeHeight | null
  bodyHair: TypeBodyHair | null
  grooming: TypeGrooming | null
  energy: TypeEnergy | null
}

export const EMPTY_TYPE_PREFERENCES: TypePreferences = {
  build: null,
  height: null,
  bodyHair: null,
  grooming: null,
  energy: null,
}

const DOESNT_MATTER = "Doesn't matter"

export const TYPE_BUILD_LABELS: Record<TypeBuild, string> = {
  slim: 'Slim',
  athletic: 'Athletic',
  average: 'Average',
  curvy: 'Curvy',
  full_figured: 'Full-figured',
  muscular: 'Muscular',
  soft: 'Soft',
  doesnt_matter: DOESNT_MATTER,
}

export const TYPE_HEIGHT_LABELS: Record<TypeHeight, string> = {
  shorter: 'Shorter than me',
  similar: 'Similar height',
  taller: 'Taller',
  much_taller: 'Much taller',
  doesnt_matter: DOESNT_MATTER,
}

export const TYPE_BODY_HAIR_LABELS: Record<TypeBodyHair, string> = {
  smooth: 'Smooth',
  some: 'Some',
  natural: 'Natural',
  doesnt_matter: DOESNT_MATTER,
}

export const TYPE_GROOMING_LABELS: Record<TypeGrooming, string> = {
  clean_cut: 'Clean cut',
  stubble: 'Stubble',
  bearded: 'Bearded',
  natural: 'Natural',
  doesnt_matter: DOESNT_MATTER,
}

export const TYPE_ENERGY_LABELS: Record<TypeEnergy, string> = {
  quiet: 'Quiet',
  calm: 'Calm',
  passionate: 'Passionate',
  intense: 'Intense',
  playful: 'Playful',
  wild: 'Wild',
  doesnt_matter: DOESNT_MATTER,
}

export const TYPE_PREFERENCE_FIELDS: { key: keyof TypePreferences; title: string; labels: Record<string, string> }[] = [
  { key: 'build', title: 'Build', labels: TYPE_BUILD_LABELS },
  { key: 'height', title: 'Height', labels: TYPE_HEIGHT_LABELS },
  { key: 'bodyHair', title: 'Body hair', labels: TYPE_BODY_HAIR_LABELS },
  { key: 'grooming', title: 'Grooming', labels: TYPE_GROOMING_LABELS },
  { key: 'energy', title: 'Energy', labels: TYPE_ENERGY_LABELS },
]

function has(record: Record<string, string>, key: unknown): key is string {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(record, key)
}

// A stored typePreferences map, keeping only known values.
export function parseTypePreferences(v: unknown): TypePreferences {
  const d = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const prefs: TypePreferences = { ...EMPTY_TYPE_PREFERENCES }
  for (const { key, labels } of TYPE_PREFERENCE_FIELDS) {
    const value = d[key]
    if (has(labels, value)) (prefs as unknown as Record<string, string | null>)[key] = value
  }
  return prefs
}

// The real preferences as "Title: Label" — "Doesn't matter" and unanswered
// categories are left out.
export function typePreferenceLabels(prefs: TypePreferences): string[] {
  return TYPE_PREFERENCE_FIELDS.flatMap(({ key, title, labels }) => {
    const value = prefs[key]
    return value && value !== 'doesnt_matter' ? [`${title}: ${labels[value]}`] : []
  })
}

// e.g. 178 → 5'10"
export function formatHeightCm(cm: number): string {
  const total = Math.round(cm / 2.54)
  return `${Math.floor(total / 12)}'${total % 12}"`
}

// The self-description as display labels, in step order. "Prefer not to say"
// and unanswered fields are left out.
export function playDescriptorLabels(d: {
  playHeight?: unknown
  playBodyType?: unknown
  playBodyHair?: unknown
  playGrooming?: unknown
  playEnergy?: unknown
}): string[] {
  const pick = (record: Record<string, string>, v: unknown, suffix = '') =>
    has(record, v) && v !== 'prefer_not_to_say' ? [`${record[v]}${suffix}`] : []
  return [
    ...(typeof d.playHeight === 'number' && d.playHeight > 0 ? [formatHeightCm(d.playHeight)] : []),
    ...pick(PLAY_BODY_TYPE_LABELS, d.playBodyType),
    ...pick(PLAY_BODY_HAIR_LABELS, d.playBodyHair, ' body hair'),
    ...pick(PLAY_GROOMING_LABELS, d.playGrooming),
    ...pick(PLAY_ENERGY_LABELS, d.playEnergy, ' energy'),
  ]
}
