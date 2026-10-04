import { doc, getDoc, type DocumentData } from 'firebase/firestore'
import { db } from './firebase'
import type { PromptAnswer } from '../types/dualProfile'
import { parseTypePreferences, playDescriptorLabels, type TypePreferences } from '../types/playDescriptors'

// users/{uid}/playProfile/data — the Play face of a profile. Kept free of
// other service imports so discover.ts and profile.ts can both use it.
export interface PlayProfileData {
  photoURLs: string[]
  playBio: string
  spiceLevel: string | null
  playInterestTags: string[]
  playNonNegotiables: string[]
  promptAnswers: PromptAnswer[]
  // "A little about you" as display labels (height, body type, …).
  descriptors: string[]
  typePreferences: TypePreferences
  goDeeper: { question: string; answer: string }[]
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

// Answers come as the promptAnswers array (mobile, bots, web) or the
// playPromptAnswers { promptId: answer } map (web onboarding).
function playPrompts(d: DocumentData): PromptAnswer[] {
  if (Array.isArray(d.promptAnswers)) {
    return d.promptAnswers.filter(
      (p: unknown): p is PromptAnswer =>
        typeof (p as PromptAnswer)?.promptId === 'string' &&
        typeof (p as PromptAnswer)?.answer === 'string' &&
        (p as PromptAnswer).answer.trim() !== '',
    )
  }
  if (typeof d.playPromptAnswers === 'object' && d.playPromptAnswers !== null) {
    return Object.entries(d.playPromptAnswers)
      .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '')
      .map(([promptId, answer]) => ({ promptId, answer }))
  }
  return []
}

export function parsePlayProfile(d: DocumentData): PlayProfileData {
  return {
    photoURLs: strings(d.photoURLs),
    playBio: typeof d.playBio === 'string' ? d.playBio.trim() : '',
    spiceLevel: typeof d.spiceLevel === 'string' && d.spiceLevel ? d.spiceLevel : null,
    playInterestTags: strings(d.playInterestTags),
    playNonNegotiables: strings(d.playNonNegotiables),
    promptAnswers: playPrompts(d),
    descriptors: playDescriptorLabels(d),
    typePreferences: parseTypePreferences(d.typePreferences),
    goDeeper: Array.isArray(d.goDeeper)
      ? d.goDeeper.filter(
          (g: unknown): g is { question: string; answer: string } =>
            typeof (g as { question?: unknown })?.question === 'string' &&
            typeof (g as { answer?: unknown })?.answer === 'string' &&
            (g as { answer: string }).answer.trim() !== '',
        )
      : [],
  }
}

// Someone's Play profile, or null if they don't have one (or it can't be read).
export async function loadPlayProfile(uid: string): Promise<PlayProfileData | null> {
  const snap = await getDoc(doc(db, `users/${uid}/playProfile/data`)).catch(() => null)
  const d = snap?.data()
  return d ? parsePlayProfile(d) : null
}
