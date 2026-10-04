import { deleteDoc, deleteField, doc, getDoc, updateDoc, writeBatch } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'

// Deleting one mode's profile keeps the account and the other mode. Each
// returns whether the other profile exists, which decides where the user
// lands: the other mode, or (nothing left) signed out back to onboarding.

// The Play profile's published photos, or null if there's no Play profile.
async function playPhotos(uid: string): Promise<string[] | null> {
  const data = (await getDoc(doc(db, `users/${uid}/playProfile/data`))).data()
  if (!data) return null
  return Array.isArray(data.photoURLs) ? data.photoURLs.filter((u: unknown): u is string => typeof u === 'string') : []
}

async function hasSparkProfile(uid: string): Promise<boolean> {
  if ((await getDoc(doc(db, `users/${uid}/sparkProfile/data`))).exists()) return true
  // Mobile-created profiles may only have the root doc.
  const root = (await getDoc(doc(db, 'users', uid))).data()
  return root?.onboardingPath !== 'play' && Array.isArray(root?.photoURLs) && root.photoURLs.length > 0
}

// Spark lives on the root doc (plus sparkProfile/data). Identity (name, age,
// gender, attraction) stays — Play uses it too.
export async function deleteSparkProfile(uid: string): Promise<{ playRemains: boolean }> {
  const remainingPlayPhotos = await playPhotos(uid)
  const playRemains = remainingPlayPhotos !== null
  const batch = writeBatch(db)
  batch.update(doc(db, 'users', uid), {
    sparkVisibility: 'hidden',
    bio: deleteField(),
    // Explore reads root photoURLs; a Play-only account shows its Play photos
    // there (mirrorPlayOnlyPhotos only syncs when the Play profile changes).
    photoURLs: remainingPlayPhotos ?? [],
    promptAnswers: [],
    personalityTraits: [],
    relationshipValues: [],
    lifestyleTags: [],
    habitTags: [],
    weekendVibes: [],
    loveLangGive: [],
    loveLangReceive: [],
    openTo: [],
    heightCm: deleteField(),
    bodyType: deleteField(),
    // With Play left they become Play-only (in Play Explore only, launched
    // straight into Play). With nothing left, onboarding starts over.
    ...(playRemains ? { onboardingPath: 'play', intent: 'play' } : { onboardingComplete: false }),
  })
  batch.delete(doc(db, `users/${uid}/sparkProfile/data`))
  await batch.commit()
  return { playRemains }
}

const PLAY_ROOT_FIELDS = [
  'spiceLevel',
  'playInterestTags',
  'playNonNegotiables',
  'playBio',
  'playPromptAnswers',
  'playGoDeeper',
  'typePreferences',
  'playBodyHair',
  'playGrooming',
  'playEnergy',
  'playHeight',
  'playBodyType',
] as const

export async function deletePlayProfile(uid: string): Promise<{ sparkRemains: boolean }> {
  const sparkRemains = await hasSparkProfile(uid)
  await deleteDoc(doc(db, `users/${uid}/playProfile/data`))
  await updateDoc(doc(db, 'users', uid), {
    ...Object.fromEntries(PLAY_ROOT_FIELDS.map((f) => [f, deleteField()])),
    playVisibility: 'hidden',
    ...(sparkRemains ? { onboardingPath: 'spark', intent: 'spark' } : { onboardingComplete: false }),
  })
  return { sparkRemains }
}

// The same server flow as mobile's Settings → Delete account.
export async function deleteAccount(): Promise<void> {
  await httpsCallable<void, { success: boolean }>(functions, 'deleteAccount')()
}
