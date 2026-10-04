import { arrayRemove, doc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore'
import { deleteObject, ref } from 'firebase/storage'
import { db, storage } from './firebase'
import { answeredGoDeeper, answeredPrompts, descriptorFields, type PlayDraft } from './playOnboarding'

// The Edit Play profile page (/edit-play-profile): section-by-section edits
// of a saved Play profile. Only changed fields are written — to
// playProfile/data and to the root-doc mirrors mobile reads. Photos save on
// their own, immediately (like Spark's Edit Profile).

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// The changed fields as { playProfile, root } updates, empty when nothing changed.
function changes(before: PlayDraft, after: PlayDraft) {
  const playProfile: Record<string, unknown> = {}
  const root: Record<string, unknown> = {}
  const both = (key: string, value: unknown) => {
    playProfile[key] = value
    root[key] = value
  }

  // The Play name isn't here: it changes through updateDisplayName.
  if (after.bio.trim() !== before.bio.trim()) both('playBio', after.bio.trim())
  if (after.spiceLevel !== before.spiceLevel) both('spiceLevel', after.spiceLevel)
  if (!same(after.tags, before.tags)) both('playInterestTags', after.tags)
  if (!same(after.nonNegotiables, before.nonNegotiables)) both('playNonNegotiables', after.nonNegotiables)

  const beforeDescriptors = descriptorFields(before)
  const afterDescriptors = descriptorFields(after)
  for (const key of Object.keys(afterDescriptors) as (keyof typeof afterDescriptors)[]) {
    if (!same(afterDescriptors[key], beforeDescriptors[key])) both(key, afterDescriptors[key])
  }

  const prompts = answeredPrompts(after)
  if (!same(prompts, answeredPrompts(before))) {
    // Both shapes, as Play onboarding writes them; update() replaces the map
    // whole, so a swapped-out prompt doesn't linger.
    playProfile.playPromptAnswers = Object.fromEntries(prompts.map((p) => [p.promptId, p.answer]))
    playProfile.promptAnswers = prompts
    root.playPromptAnswers = prompts
  }
  const goDeeper = answeredGoDeeper(after)
  if (!same(goDeeper, answeredGoDeeper(before))) {
    playProfile.goDeeper = goDeeper
    root.playGoDeeper = goDeeper
  }
  return { playProfile, root }
}

export function playNameChanged(before: PlayDraft, after: PlayDraft): boolean {
  const name = after.playDisplayName.trim()
  return name !== '' && name !== before.playDisplayName.trim()
}

export function hasPlayChanges(before: PlayDraft, after: PlayDraft): boolean {
  return playNameChanged(before, after) || Object.keys(changes(before, after).playProfile).length > 0
}

export async function savePlayEdits(uid: string, before: PlayDraft, after: PlayDraft): Promise<void> {
  const { playProfile, root } = changes(before, after)
  if (Object.keys(playProfile).length === 0) return
  const batch = writeBatch(db)
  batch.update(doc(db, `users/${uid}/playProfile/data`), { ...playProfile, lastUpdated: Date.now() })
  batch.update(doc(db, 'users', uid), { ...root, profileUpdatedAt: serverTimestamp() })
  await batch.commit()
}

// Storage path of a published photo: signed URL (storage.googleapis.com/
// {bucket}/{path}) or Firebase download URL (…/o/{path}).
function storagePathOf(url: string): string | null {
  try {
    const u = new URL(url)
    const firebase = /\/o\/(.+)$/.exec(u.pathname)
    if (firebase) return decodeURIComponent(firebase[1])
    if (u.hostname === 'storage.googleapis.com') return decodeURIComponent(u.pathname.split('/').slice(2).join('/'))
  } catch {
    // Not a URL we can map to a path.
  }
  return null
}

// Removes a Play photo now. mirrorPlayOnlyPhotos keeps a Play-only account's
// root photoURLs in step.
export async function removePlayPhoto(uid: string, url: string): Promise<void> {
  await updateDoc(doc(db, `users/${uid}/playProfile/data`), { photoURLs: arrayRemove(url), lastUpdated: Date.now() })
  const path = storagePathOf(url)
  if (path?.startsWith(`photos/${uid}/play/`)) await deleteObject(ref(storage, path)).catch(() => {})
}
