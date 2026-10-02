import { doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { db, functions } from './firebase'
import { uploadModeratedPhotos } from './moderatedPhotos'
import {
  PLAY_TAG_LABELS,
  type PlayInterestTag,
  type PlayNonNegotiable,
  type SpiceLevel,
} from '../types/dualProfile'
import type { PhotoDraft } from '../components/onboarding/types'

export type PlayTagCategory = 'arrangement' | 'acts' | 'dynamic' | 'vibe' | 'place'

export interface PlayDraft {
  photos: PhotoDraft[]
  bio: string
  spiceLevel: SpiceLevel | null
  // Every selected tag, across all five categories.
  tags: PlayInterestTag[]
  nonNegotiables: PlayNonNegotiable[]
  // The three prompts shown (seeded per user, swappable) and their answers.
  promptIds: string[]
  answers: Record<string, string>
}

export function tagsIn(tags: PlayInterestTag[], category: PlayTagCategory): PlayInterestTag[] {
  return tags.filter((t) => PLAY_TAG_LABELS[t]?.category === category)
}

function answeredPrompts(d: PlayDraft): { promptId: string; answer: string }[] {
  return d.promptIds
    .map((promptId) => ({ promptId, answer: (d.answers[promptId] ?? '').trim() }))
    .filter((p) => p.answer)
}

// ─── Bio ─────────────────────────────────────────────────────────────────────

export type PlayBioResult = { bio: string } | { error: 'limit' | 'failed' }

// Server-side generation (generatePlayBio); never calls Anthropic from here.
// gender/attraction come from the root profile, which Play shares.
export async function generatePlayBio(
  d: PlayDraft,
  identity: { genderIdentity: unknown; attractedTo: unknown },
): Promise<PlayBioResult> {
  try {
    const { data } = await httpsCallable<object, { bio?: string }>(functions, 'generatePlayBio', { timeout: 30_000 })({
      spiceLevel: d.spiceLevel,
      arrangement: tagsIn(d.tags, 'arrangement'),
      acts: tagsIn(d.tags, 'acts'),
      dynamic: tagsIn(d.tags, 'dynamic'),
      vibe: tagsIn(d.tags, 'vibe'),
      place: tagsIn(d.tags, 'place'),
      nonNegotiables: d.nonNegotiables,
      promptAnswers: answeredPrompts(d),
      genderIdentity: identity.genderIdentity,
      attractedTo: identity.attractedTo,
    })
    const bio = data.bio?.trim()
    return bio ? { bio } : { error: 'failed' }
  } catch (err) {
    return { error: err instanceof FirebaseError && err.code === 'functions/resource-exhausted' ? 'limit' : 'failed' }
  }
}

// ─── Save ────────────────────────────────────────────────────────────────────


// Writes the Play profile and marks the user as having both profiles, in one
// batch, then sends new photos through moderation (onPhotoUpload publishes them
// to playProfile/data, which must exist first). Resolves with notices for
// photos that didn't publish — empty when they all passed. Prompt answers go out in both shapes: the playPromptAnswers map, and
// the promptAnswers array that mobile and the web profile view read.
// Editing (keepIntent) leaves the root intent alone: a Play-only mobile user
// must not be switched to 'open' just by updating their Play profile.
export async function savePlayOnboarding(uid: string, d: PlayDraft, { keepIntent = false } = {}): Promise<string[]> {
  const prompts = answeredPrompts(d)
  const bio = d.bio.trim()
  // Only already-published photos (editing) are written here.
  const photoURLs = d.photos.filter((p) => p.file === null).map((p) => p.previewUrl)
  const newPhotos = d.photos.map((p) => p.file).filter((f): f is File => f !== null)

  const playRef = doc(db, `users/${uid}/playProfile/data`)
  const existing = await getDoc(playRef)
  const now = Date.now()
  const batch = writeBatch(db)
  batch.set(
    playRef,
    {
      uid,
      photoURLs,
      playBio: bio,
      spiceLevel: d.spiceLevel,
      playInterestTags: d.tags,
      playNonNegotiables: d.nonNegotiables,
      playPromptAnswers: Object.fromEntries(prompts.map((p) => [p.promptId, p.answer])),
      promptAnswers: prompts,
      playOnboardingComplete: true,
      aiPhotoScanningConsent: true,
      isActive: d.photos.length > 0,
      lastUpdated: now,
      ...(!existing.exists() && { createdAt: now, radiusMiles: 25, ageMin: 21, ageMax: 45 }),
    },
    { merge: true },
  )
  // Mirrors mobile's Play onboarding: mobile Discover and profile cards read
  // these Play fields from the root doc, not the playProfile subcollection.
  batch.update(doc(db, 'users', uid), {
    ...(!keepIntent && { intent: 'open' }),
    spiceLevel: d.spiceLevel,
    playInterestTags: d.tags,
    playNonNegotiables: d.nonNegotiables,
    playBio: bio,
    playPromptAnswers: prompts,
    profileUpdatedAt: serverTimestamp(),
  })
  await batch.commit()

  const { notices } = await uploadModeratedPhotos(uid, 'play', newPhotos)
  return notices
}

// ─── Edit ────────────────────────────────────────────────────────────────────

const PROMPT_SLOTS = 3

// The saved Play profile as an onboarding draft, or null if there isn't one.
// Photos come back as already-uploaded entries (file: null); prompt slots are
// the saved answers, topped up with the suggested prompts.
export async function loadPlayDraft(uid: string, suggested: string[]): Promise<PlayDraft | null> {
  const snap = await getDoc(doc(db, `users/${uid}/playProfile/data`))
  const d = snap.data()
  if (!d) return null
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])

  const answers: Record<string, string> = {}
  if (Array.isArray(d.promptAnswers)) {
    for (const a of d.promptAnswers) {
      if (typeof a?.promptId === 'string' && typeof a?.answer === 'string' && a.answer.trim()) answers[a.promptId] = a.answer
    }
  } else if (typeof d.playPromptAnswers === 'object' && d.playPromptAnswers !== null) {
    for (const [id, answer] of Object.entries(d.playPromptAnswers)) {
      if (typeof answer === 'string' && answer.trim()) answers[id] = answer
    }
  }
  const promptIds = Object.keys(answers).slice(0, PROMPT_SLOTS)
  for (const id of suggested) {
    if (promptIds.length >= PROMPT_SLOTS) break
    if (!promptIds.includes(id)) promptIds.push(id)
  }

  return {
    photos: strings(d.photoURLs).map((url) => ({ id: url, file: null, previewUrl: url })),
    bio: typeof d.playBio === 'string' ? d.playBio : '',
    spiceLevel: typeof d.spiceLevel === 'string' ? (d.spiceLevel as SpiceLevel) : null,
    tags: strings(d.playInterestTags) as PlayInterestTag[],
    nonNegotiables: strings(d.playNonNegotiables) as PlayNonNegotiable[],
    promptIds,
    answers,
  }
}
