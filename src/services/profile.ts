import { arrayRemove, arrayUnion, deleteField, doc, getDoc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore'
import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { db, functions, storage } from './firebase'
import { displayAge, type DiscoverProfile } from './discover'
import type { SparkBioRequest } from './bio'
import type { PromptAnswer } from '../types/dualProfile'

export const MAX_PROFILE_PHOTOS = 9
export const MAX_PROMPTS = 5
export const BIO_LIMIT = 300
export const PROMPT_ANSWER_LIMIT = 200
const MAX_PHOTO_BYTES = 10 * 1024 * 1024 // storage.rules limit

export interface OwnProfile {
  profile: DiscoverProfile
  bio: string
  prompts: PromptAnswer[]
  // Root dealbreakers (mobile) plus the private seeking prefs (web onboarding).
  dealbreakers: string[]
  // Traits they want in a partner; same two sources as dealbreakers.
  seekingTraits: string[]
  // Question text for the AI-written prompt, stored under promptId 'dynamic'
  // (mobile's convention for its Play "just for you" question).
  dynamicPrompt: string | null
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

function promptList(v: unknown): PromptAnswer[] {
  if (Array.isArray(v)) {
    return v.filter(
      (p): p is PromptAnswer => typeof p?.promptId === 'string' && typeof p?.answer === 'string' && p.answer.trim() !== '',
    )
  }
  // Web onboarding's sparkPromptAnswers is a { promptId: answer } map.
  if (typeof v === 'object' && v !== null) {
    return Object.entries(v)
      .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '')
      .map(([promptId, answer]) => ({ promptId, answer }))
  }
  return []
}

// The Spark profile lives in three places: the root doc (what Discover reads),
// sparkProfile/data (what both editors write) and the private seeking prefs.
export async function loadOwnProfile(uid: string): Promise<OwnProfile | null> {
  const [root, spark, seeking] = await Promise.all([
    getDoc(doc(db, 'users', uid)),
    getDoc(doc(db, `users/${uid}/sparkProfile/data`)).catch(() => null),
    getDoc(doc(db, `users/${uid}/seekingPreferences/prefs`)).catch(() => null),
  ])
  if (!root.exists()) return null
  const profile = { ...(root.data() as DiscoverProfile), uid }
  const sp = spark?.data() ?? {}

  // Mobile's editor saves the bio only to sparkProfile/data, so it wins.
  const bio = (typeof sp.bio === 'string' && sp.bio.trim() ? sp.bio : profile.bio ?? '').trim()
  const fromSpark = promptList(sp.sparkPromptAnswers)
  const prompts = fromSpark.length > 0 ? fromSpark : promptList(sp.promptAnswers)
  return {
    profile,
    bio,
    prompts: prompts.length > 0 ? prompts : promptList(profile.promptAnswers),
    dealbreakers: [...new Set([...strings(profile.dealbreakers), ...strings(seeking?.data()?.dealbreakers)])],
    seekingTraits: [...new Set([...strings(profile.seekingTraits), ...strings(seeking?.data()?.seekingTraits)])],
    dynamicPrompt: str(sp.dynamicPrompt) ?? str((profile as Record<string, unknown>).dynamicPrompt),
  }
}

// ─── Completeness ────────────────────────────────────────────────────────────
// Weights: photos 20, bio 15, prompts 20, tags 25, Go Deeper 10, love languages 10.

export function profileCompleteness({ profile: p, bio, prompts }: OwnProfile): number {
  const share = (have: number, need: number, weight: number) => (Math.min(have, need) / need) * weight
  const tagSections = [p.personalityTraits, p.lifestyleTags, p.habitTags, p.weekendVibes, p.relationshipValues]
  const goDeeper = [p.conflictStyle, p.togethernessStyle, p.stressResponse].filter(Boolean).length
  const score =
    share(strings(p.photoURLs).length, 3, 20) +
    (bio.length >= 20 ? 15 : 0) +
    share(prompts.length, 3, 20) +
    share(tagSections.filter((t) => strings(t).length > 0).length, tagSections.length, 25) +
    share(goDeeper, 3, 10) +
    share([p.loveLangGive, p.loveLangReceive].filter((l) => strings(l).length > 0).length, 2, 10)
  return Math.round(score)
}

// ─── Saving ──────────────────────────────────────────────────────────────────

export interface SparkEdits {
  displayName: string
  pronouns: string
  bio: string
  prompts: PromptAnswer[]
}

// Writes the root doc (Discover and the profile view read it) and
// sparkProfile/data (both editors load from it) so the two never disagree.
// A changed profileUpdatedAt triggers onProfileWrite rescoring.
export async function saveSparkEdits(uid: string, e: SparkEdits): Promise<void> {
  const bio = e.bio.trim()
  const promptAnswers = e.prompts
    .map((p) => ({ promptId: p.promptId, answer: p.answer.trim() }))
    .filter((p) => p.answer)
  const pronouns = e.pronouns.trim()
  const batch = writeBatch(db)
  batch.update(doc(db, 'users', uid), {
    displayName: e.displayName.trim(),
    pronouns: pronouns || deleteField(),
    bio,
    promptAnswers,
    profileUpdatedAt: serverTimestamp(),
  })
  batch.set(
    doc(db, `users/${uid}/sparkProfile/data`),
    {
      uid,
      bio,
      promptAnswers,
      sparkPromptAnswers: Object.fromEntries(promptAnswers.map((p) => [p.promptId, p.answer])),
      lastUpdated: Date.now(),
    },
    { merge: true },
  )
  await batch.commit()
}

export interface GoDeeperEdits {
  conflictStyle: string
  togethernessStyle: string
  stressResponse: string
}

// A changed profileUpdatedAt triggers onProfileWrite rescoring.
export async function saveGoDeeper(uid: string, a: GoDeeperEdits): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { ...a, profileUpdatedAt: serverTimestamp() })
}

// ─── Photos ──────────────────────────────────────────────────────────────────
// Same Storage path and direct photoURLs write as web onboarding.

export function photoError(file: File): string | null {
  if (!file.type.startsWith('image/')) return 'Choose an image file.'
  if (file.size > MAX_PHOTO_BYTES) return 'Photos must be under 10 MB.'
  return null
}

export async function uploadProfilePhoto(uid: string, file: File): Promise<string> {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'jpg'
  const photoRef = ref(storage, `users/${uid}/photos/${Date.now()}.${ext}`)
  await uploadBytes(photoRef, file, { contentType: file.type })
  const url = await getDownloadURL(photoRef)
  try {
    await updateDoc(doc(db, 'users', uid), { photoURLs: arrayUnion(url), profileUpdatedAt: serverTimestamp() })
  } catch (err) {
    await deleteObject(photoRef).catch(() => {})
    throw err
  }
  return url
}

// arrayRemove, never a rewrite of the whole list, so photos added elsewhere
// (mobile, moderation) are never dropped.
export async function removeProfilePhoto(uid: string, url: string): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { photoURLs: arrayRemove(url), profileUpdatedAt: serverTimestamp() })
  // Best effort: the file may live under a path this client can't delete.
  await deleteObject(ref(storage, url)).catch(() => {})
}

// ─── Bio ─────────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

// Regenerates the bio from the saved profile plus the editor's current name
// and prompts. Returns null on any failure.
export async function regenerateBio(p: DiscoverProfile, displayName: string, prompts: PromptAnswer[]): Promise<string | null> {
  const raw = p as Record<string, unknown>
  const gender: unknown = Array.isArray(raw.genderIdentity) ? raw.genderIdentity[0] : raw.genderIdentity
  const request: SparkBioRequest = {
    displayName: displayName.trim() || p.displayName || '',
    genderIdentity: str(gender),
    pronouns: str(p.pronouns),
    age: displayAge(p),
    heightCm: typeof p.heightCm === 'number' && p.heightCm > 0 ? p.heightCm : null,
    bodyType: str(p.bodyType),
    drinkingHabit: str(raw.drinkingHabit),
    religion: str(p.religion),
    politicalView: str(p.politicalView),
    relationshipStatus: str(p.relationshipStatus),
    openTo: strings(p.openTo),
    lifestyleTags: strings(p.lifestyleTags),
    habitTags: strings(p.habitTags),
    personalityTraits: strings(p.personalityTraits),
    relationshipValues: strings(p.relationshipValues),
    weekendVibes: strings(p.weekendVibes),
    loveLangGive: strings(p.loveLangGive),
    loveLangReceive: strings(p.loveLangReceive),
    parentalCurrent: str(p.parentalCurrent),
    parentalIntent: str(p.parentalIntent),
    seekingTraits: strings(raw.seekingTraits),
    dealbreakers: strings(p.dealbreakers),
    sparkPromptAnswers: Object.fromEntries(prompts.filter((q) => q.answer.trim()).map((q) => [q.promptId, q.answer.trim()])),
    conflictStyle: str(p.conflictStyle),
    togethernessStyle: str(p.togethernessStyle),
    stressResponse: str(p.stressResponse),
    intent: str(p.intent),
  }
  try {
    const { data } = await httpsCallable<SparkBioRequest, { bio?: string }>(functions, 'generateSparkBio', {
      timeout: 30_000,
    })(request)
    const bio = data.bio?.trim()
    return bio && bio.length >= 20 ? bio.slice(0, BIO_LIMIT) : null
  } catch {
    return null
  }
}

// ─── AI: "Just for you" question ─────────────────────────────────────────────

export const DYNAMIC_PROMPT_ID = 'dynamic'

function questionKey(uid: string): string {
  return `zylove_profile_question_${uid}`
}

const questionRequests = new Map<string, Promise<string>>()

// One generated question per browser session; concurrent callers share a request.
export function fetchProfileQuestion(uid: string): Promise<string> {
  try {
    const cached = sessionStorage.getItem(questionKey(uid))
    if (cached) return Promise.resolve(cached)
  } catch {
    // Storage unavailable — generate a fresh one.
  }
  let request = questionRequests.get(uid)
  if (!request) {
    request = httpsCallable<void, { question: string }>(functions, 'generateProfileQuestion', { timeout: 60_000 })()
      .then(({ data }) => {
        try {
          sessionStorage.setItem(questionKey(uid), data.question)
        } catch {
          // Not cached; the next load asks again.
        }
        return data.question
      })
      .finally(() => questionRequests.delete(uid))
    questionRequests.set(uid, request)
  }
  return request
}

// Saves the answer as the profile's one 'dynamic' prompt, replacing any
// earlier one, in the same places saveSparkEdits writes. Returns the new list.
export async function saveDynamicPrompt(
  uid: string,
  prompts: PromptAnswer[],
  question: string,
  answer: string,
): Promise<PromptAnswer[]> {
  const promptAnswers = [
    ...prompts.filter((p) => p.promptId !== DYNAMIC_PROMPT_ID && p.answer.trim()),
    { promptId: DYNAMIC_PROMPT_ID, answer: answer.trim() },
  ]
  const batch = writeBatch(db)
  batch.update(doc(db, 'users', uid), { promptAnswers, dynamicPrompt: question, profileUpdatedAt: serverTimestamp() })
  batch.set(
    doc(db, `users/${uid}/sparkProfile/data`),
    {
      promptAnswers,
      sparkPromptAnswers: Object.fromEntries(promptAnswers.map((p) => [p.promptId, p.answer])),
      dynamicPrompt: question,
      lastUpdated: Date.now(),
    },
    { merge: true },
  )
  await batch.commit()
  return promptAnswers
}

// ─── AI: profile review ──────────────────────────────────────────────────────

export interface ProfileReview {
  strengths: string[]
  improvements: string[]
  headline: string
}

export async function fetchProfileReview(): Promise<ProfileReview> {
  const { data } = await httpsCallable<void, ProfileReview>(functions, 'reviewProfile', { timeout: 60_000 })()
  return data
}
