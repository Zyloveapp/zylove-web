import { deleteField, doc, getDoc, setDoc, updateDoc, writeBatch } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { loadPrivateProfile, privateProfileDoc } from './privateProfile'
import { loadFieldStates, remainingModeIntent } from './fieldLocks'

// Deleting one mode's profile keeps the account and the other mode. Each
// returns whether the other profile exists, which decides where the user
// lands: the other mode, or (nothing left) signed out back to onboarding.

// Deletes every file under photos/{uid}/{mode}/ (deleteModePhotos callable).
// Never blocks the profile deletion: a failure is only logged.
async function deletePhotoFolder(mode: 'spark' | 'play'): Promise<void> {
  try {
    await httpsCallable(functions, 'deleteModePhotos')({ mode })
  } catch (err) {
    console.warn(`Couldn't delete ${mode} photo files`, err)
  }
}

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
  const path = (await loadPrivateProfile(uid, root)).onboardingPath
  return path !== 'play' && Array.isArray(root?.photoURLs) && root.photoURLs.length > 0
}

// Spark lives on the root doc (plus sparkProfile/data). Identity (name, age,
// gender, attraction) stays — Play uses it too.
export async function deleteSparkProfile(uid: string): Promise<{ playRemains: boolean }> {
  const [remainingPlayPhotos, fieldStates] = await Promise.all([playPhotos(uid), loadFieldStates(uid)])
  const playRemains = remainingPlayPhotos !== null
  const batch = writeBatch(db)
  batch.update(doc(db, 'users', uid), {
    sparkVisibility: 'hidden',
    bio: deleteField(),
    // Spark photos only — Play photos never sit on the public doc (Stage 2).
    photoURLs: [],
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
    // With nothing left, onboarding starts over.
    ...(!playRemains && { onboardingComplete: false }),
  })
  // With Play left they become Play-only (in Play Explore only, launched
  // straight into Play) — recorded in the owner-only private/profile. F-099:
  // the intent change is stamped (never blocked; remainingModeIntent).
  if (playRemains) {
    batch.set(privateProfileDoc(uid), { onboardingPath: 'play', mode: 'play', ...remainingModeIntent(fieldStates, 'play') }, { merge: true })
  }
  batch.delete(doc(db, `users/${uid}/sparkProfile/data`))
  await batch.commit()
  // Spark photos still in review go with the files (deleteModePhotos), except
  // ones held for their content, which stay for review (F-081).
  await deletePhotoFolder('spark')
  return { playRemains }
}

// Play lives in playProfile/data alone (Stage 2); deleting it removes it.
// Server-side (deletePlayProfile callable, F-079), which keeps the Play
// name's 30-day lock.
export async function deletePlayProfile(uid: string): Promise<{ sparkRemains: boolean }> {
  const sparkRemains = await hasSparkProfile(uid)
  await httpsCallable(functions, 'deletePlayProfile')()
  // F-099: the intent change is stamped (never blocked; remainingModeIntent).
  if (sparkRemains) {
    const intent = remainingModeIntent(await loadFieldStates(uid), 'spark')
    await setDoc(privateProfileDoc(uid), { onboardingPath: 'spark', mode: 'spark', ...intent }, { merge: true })
  }
  if (!sparkRemains) await updateDoc(doc(db, 'users', uid), { onboardingComplete: false })
  await deletePhotoFolder('play')
  return { sparkRemains }
}

// The same server flow as mobile's Settings → Delete account.
export async function deleteAccount(): Promise<void> {
  await httpsCallable<void, { success: boolean }>(functions, 'deleteAccount')()
}
