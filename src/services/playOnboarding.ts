import { doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore'
import { deleteObject, getDownloadURL, ref, uploadBytes, type StorageReference } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { db, functions, storage } from './firebase'
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

// photos/{uid}/play/... is the path storage.rules allows for Play photos (the
// mobile app's path); users/{uid}/photos/ only allows one level, no subfolder.
async function uploadPlayPhotos(uid: string, photos: PhotoDraft[]): Promise<{ refs: StorageReference[]; urls: string[] }> {
  const files = photos.map((p) => p.file).filter((f): f is File => f !== null)
  const stamp = Date.now()
  const refs = files.map((file, i) => {
    const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'jpg'
    return ref(storage, `photos/${uid}/play/${stamp}-${i}.${ext}`)
  })
  const results = await Promise.allSettled(files.map((file, i) => uploadBytes(refs[i], file, { contentType: file.type })))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) {
    await Promise.allSettled(refs.filter((_, i) => results[i].status === 'fulfilled').map((r) => deleteObject(r)))
    throw failed.reason
  }
  const uploaded = await Promise.all(refs.map((r) => getDownloadURL(r)))
  let next = 0
  return { refs, urls: photos.map((p) => (p.file ? uploaded[next++] : p.previewUrl)) }
}

// Writes the Play profile and marks the user as having both profiles, in one
// batch. Prompt answers go out in both shapes: the playPromptAnswers map, and
// the promptAnswers array that mobile and the web profile view read.
export async function savePlayOnboarding(uid: string, d: PlayDraft): Promise<void> {
  const prompts = answeredPrompts(d)
  const bio = d.bio.trim()
  const { refs, urls: photoURLs } = await uploadPlayPhotos(uid, d.photos)

  try {
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
        isActive: photoURLs.length > 0,
        lastUpdated: now,
        ...(!existing.exists() && { createdAt: now, radiusMiles: 25, ageMin: 21, ageMax: 45 }),
      },
      { merge: true },
    )
    // Mirrors mobile's Play onboarding: mobile Discover and profile cards read
    // these Play fields from the root doc, not the playProfile subcollection.
    batch.update(doc(db, 'users', uid), {
      intent: 'open',
      spiceLevel: d.spiceLevel,
      playInterestTags: d.tags,
      playNonNegotiables: d.nonNegotiables,
      playBio: bio,
      playPromptAnswers: prompts,
      profileUpdatedAt: serverTimestamp(),
    })
    await batch.commit()
  } catch (err) {
    await Promise.allSettled(refs.map((r) => deleteObject(r)))
    throw err
  }
}
