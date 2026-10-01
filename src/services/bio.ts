import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'
import { feetInchesToCm } from '../types/profile'
import { BIO_MAX_LENGTH, parseBirthday, type OnboardingDraft } from '../components/onboarding/types'

// Payload for the generateSparkBio Callable (functions/src/bioPrompt.ts).
// Enum values are profile.ts keys; the function turns them into labels.
export interface SparkBioRequest {
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

interface SparkBioResponse {
  bio?: string
}

export interface BioResult {
  bio: string
  generated: boolean
}

const MIN_BIO_LENGTH = 20

export function fallbackBio(displayName: string): string {
  return `${displayName.trim()} · Easygoing and self-aware. Looking to connect with the right person.`
}

function toRequest(d: OnboardingDraft): SparkBioRequest {
  const sparkPromptAnswers = Object.fromEntries(
    d.selectedPromptIds
      .map((id) => [id, (d.promptAnswers[id] ?? '').trim()] as const)
      .filter(([, answer]) => answer),
  )

  return {
    displayName: d.displayName.trim(),
    genderIdentity: d.genderIdentity,
    pronouns: d.pronouns.trim() || null,
    age: parseBirthday(d.birthdayRaw)?.age ?? null,
    heightCm: feetInchesToCm(d.height.feet, d.height.inches),
    bodyType: d.bodyType,
    drinkingHabit: d.drinkingHabit,
    religion: d.religion,
    politicalView: d.politicalView,
    relationshipStatus: d.relationshipStatus,
    openTo: d.openTo,
    lifestyleTags: d.lifestyleTags,
    habitTags: d.habitTags,
    personalityTraits: d.personalityTraits,
    relationshipValues: d.relationshipValues,
    weekendVibes: d.weekendVibes,
    loveLangGive: d.loveLangGive,
    loveLangReceive: d.loveLangReceive,
    parentalCurrent: d.parentalCurrent,
    parentalIntent: d.parentalIntent,
    seekingTraits: d.seekingTraits,
    dealbreakers: d.dealbreakers,
    sparkPromptAnswers,
    conflictStyle: d.conflictStyle,
    togethernessStyle: d.togethernessStyle,
    stressResponse: d.stressResponse,
    intent: d.intent,
  }
}

// Bio generation runs server-side so the Anthropic key never reaches the
// browser. Any failure (function missing, timeout, short reply) falls back.
export async function generateSparkBio(draft: OnboardingDraft): Promise<BioResult> {
  try {
    const callable = httpsCallable<SparkBioRequest, SparkBioResponse>(functions, 'generateSparkBio', {
      timeout: 20_000,
    })
    const { data } = await callable(toRequest(draft))
    const bio = data.bio?.trim()
    if (bio && bio.length >= MIN_BIO_LENGTH) return { bio: bio.slice(0, BIO_MAX_LENGTH), generated: true }
  } catch {
    // fall through to the fallback
  }
  return { bio: fallbackBio(draft.displayName), generated: false }
}
