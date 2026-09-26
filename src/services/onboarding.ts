import { doc, getDoc, writeBatch } from 'firebase/firestore'
import { deleteObject, getDownloadURL, ref, uploadBytes, type StorageReference } from 'firebase/storage'
import { db, storage } from './firebase'
import type {
  AttractedTo,
  DatingIntent,
  DatingProfile,
  Dealbreaker,
  GenderIdentity,
  RelationshipValue,
  SeekingTrait,
} from '../types/profile'
import type { PromptAnswer, SparkProfile } from '../types/dualProfile'
import type { BodyTypePreference, HeightPreference } from '../types/preferences'
import { computeSparkCompleteness } from '../types/scorecard'

// Private, owner-only doc at users/{uid}/seekingPreferences/prefs. Field names
// follow the mobile app's seeking flow where they overlap.
export interface SeekingPreferencesDoc {
  uid: string
  heightPreference: HeightPreference
  bodyTypePreference: BodyTypePreference[]
  personalityPriorities: SeekingTrait[]
  topValues: RelationshipValue[]
  dealbreakers: Dealbreaker[]
  _lastUpdated: number
}

export interface SparkOnboardingInput {
  intent: DatingIntent
  displayName: string
  age: number
  genderIdentity: GenderIdentity
  genderSelfDescribe: string
  attractedTo: AttractedTo[]
  photos: File[]
  promptAnswers: PromptAnswer[]
  seeking: Omit<SeekingPreferencesDoc, 'uid' | '_lastUpdated'>
}

// Trust/safety fields. Firestore rules reject any client create or update that
// includes them — only Cloud Functions (admin SDK) may set them.
type ServerOnlyField = 'isSuspended' | 'reportCount' | 'verificationStatus' | 'subscriptionTier'
type NewUserDoc = Omit<DatingProfile, ServerOnlyField>

// Defaults for fields mobile onboarding collects but web onboarding doesn't yet.
// Only applied when creating a brand-new users/{uid} doc.
const NEW_PROFILE_DEFAULTS = {
  relationshipStatus: 'prefer_not_to_say',
  openTo: [],
  openToCrossover: false,
  lifestyleTags: [],
  habitTags: [],
  personalityTraits: [],
  relationshipValues: [],
  weekendVibes: [],
  loveLangGive: [],
  loveLangReceive: [],
  bio: '',
  seekingBodyTypes: [],
  seekingHairColors: [],
  seekingTraits: [],
  dealbreakers: [],
  geohash: '',
  locationLabel: '',
  radiusMiles: 25,
  ageMin: 21,
  ageMax: 45,
  phoneVerified: false,
  publicKey: '',
} satisfies Partial<NewUserDoc>

async function uploadPhotos(uid: string, files: File[]): Promise<{ refs: StorageReference[]; urls: string[] }> {
  const stamp = Date.now()
  const refs = files.map((file, i) => {
    const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'jpg'
    return ref(storage, `users/${uid}/photos/${stamp}-${i}.${ext}`)
  })

  const results = await Promise.allSettled(
    files.map((file, i) => uploadBytes(refs[i], file, { contentType: file.type })),
  )
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) {
    await deletePhotos(refs.filter((_, i) => results[i].status === 'fulfilled'))
    throw failed.reason
  }

  const urls = await Promise.all(refs.map((r) => getDownloadURL(r)))
  return { refs, urls }
}

async function deletePhotos(refs: StorageReference[]): Promise<void> {
  await Promise.allSettled(refs.map((r) => deleteObject(r)))
}

// Uploads photos, then writes the root profile, Spark profile and private
// seeking prefs in a single batch so the user never ends up half-onboarded.
export async function saveSparkOnboarding(uid: string, input: SparkOnboardingInput): Promise<void> {
  const { refs, urls: photoURLs } = await uploadPhotos(uid, input.photos)

  try {
    const now = Date.now()
    const rootRef = doc(db, 'users', uid)
    const existing = await getDoc(rootRef)

    const onboardingFields = {
      uid,
      displayName: input.displayName.trim(),
      age: input.age,
      genderIdentity: input.genderIdentity,
      ...(input.genderIdentity === 'self_describe' && {
        genderSelfDescribe: input.genderSelfDescribe.trim(),
      }),
      attractedTo: input.attractedTo,
      intent: input.intent,
      photoURLs,
      promptAnswers: input.promptAnswers,
      lastActive: now,
    } satisfies Partial<DatingProfile>

    const batch = writeBatch(db)

    if (existing.exists()) {
      // Merge so fields collected elsewhere (location, bio, lifestyle…) survive,
      // and never touch the trust/safety fields the rules lock down on update.
      batch.set(rootRef, { ...onboardingFields, sparkVisibility: 'active' }, { merge: true })
    } else {
      const profile: NewUserDoc = { ...NEW_PROFILE_DEFAULTS, ...onboardingFields, createdAt: now }
      batch.set(rootRef, { ...profile, sparkVisibility: 'active' })
    }

    const spark: Partial<SparkProfile> = {
      uid,
      displayName: onboardingFields.displayName,
      age: input.age,
      genderIdentity: input.genderIdentity,
      attractedTo: input.attractedTo,
      photoURLs,
      promptAnswers: input.promptAnswers,
      intent: 'spark',
      isActive: photoURLs.length > 0,
      completeness: computeSparkCompleteness(onboardingFields),
      lastUpdated: now,
    }
    batch.set(doc(db, `users/${uid}/sparkProfile/data`), spark, { merge: true })

    const seeking: SeekingPreferencesDoc = {
      uid,
      ...input.seeking,
      bodyTypePreference: input.seeking.bodyTypePreference.length
        ? input.seeking.bodyTypePreference
        : ['no_preference'],
      _lastUpdated: now,
    }
    batch.set(doc(db, `users/${uid}/seekingPreferences/prefs`), seeking)

    await batch.commit()
  } catch (err) {
    await deletePhotos(refs)
    throw err
  }
}
