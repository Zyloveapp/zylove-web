import { doc, getDoc, type DocumentData } from 'firebase/firestore'
import { db } from './firebase'
import type { PromptAnswer } from '../types/dualProfile'
import { parseTypePreferences, playDescriptorLabels, type TypePreferences } from '../types/playDescriptors'

// users/{uid}/playProfile/data — the Play face of a profile. Kept free of
// other service imports so discover.ts and profile.ts can both use it.
export interface PlayProfileData {
  photoURLs: string[]
  // Shown instead of displayName on Play profiles; '' when unset.
  playDisplayName: string
  // Server-set (setVisibility); missing means active.
  playVisibility: 'active' | 'paused' | 'hidden'
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
    // Curated profiles (and older mobile ones) name their Play profile with
    // its own displayName — this doc's, never the root (Spark) one.
    playDisplayName: [d.playDisplayName, d.displayName].find((n): n is string => typeof n === 'string' && n.trim() !== '')?.trim() ?? '',
    playVisibility: d.playVisibility === 'paused' || d.playVisibility === 'hidden' ? d.playVisibility : 'active',
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

// F-062: someone else's Play profile is playProfiles/{playId} (by Play ID,
// no uid); your own is users/{uid}/playProfile/data (owner-only). An id that
// isn't a Play ID reads your own.
const playDoc = (id: string) => (/^p_[A-Za-z0-9]{20}$/.test(id) ? `playProfiles/${id}` : `users/${id}/playProfile/data`)

// Someone's Play profile and whether the rules refused it (Stage 2: either
// side without Play access) — denied isn't an error, just "unavailable".
export async function loadPlayProfileStatus(id: string): Promise<{ play: PlayProfileData | null; denied: boolean }> {
  try {
    const snap = await getDoc(doc(db, playDoc(id)))
    const d = snap.data()
    return { play: d ? parsePlayProfile(d) : null, denied: false }
  } catch (err) {
    return { play: null, denied: (err as { code?: string })?.code === 'permission-denied' }
  }
}

// Someone's Play profile, or null if they don't have one (or it can't be read).
export async function loadPlayProfile(id: string): Promise<PlayProfileData | null> {
  const snap = await getDoc(doc(db, playDoc(id))).catch(() => null)
  const d = snap?.data()
  return d ? parsePlayProfile(d) : null
}

// The public Play profile's extras: age and whether it's curated (F-062:
// Play shows the Play profile plus the age — nothing from Spark).
export async function loadPlayExtras(playId: string): Promise<{ age: number | null; curated: boolean; publicPlayKey: string | null }> {
  const d = (await getDoc(doc(db, `playProfiles/${playId}`)).catch(() => null))?.data()
  return {
    age: typeof d?.age === 'number' && d.age > 0 ? d.age : null,
    curated: d?.curated === true,
    publicPlayKey: typeof d?.publicPlayKey === 'string' ? d.publicPlayKey : null,
  }
}
