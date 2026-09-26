import {
  deleteField,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  writeBatch,
  type FieldValue,
} from 'firebase/firestore'
import { deleteObject, getDownloadURL, ref, uploadBytes, type StorageReference } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { db, functions, storage } from './firebase'
import {
  OFF_MAP_GENDER_IDENTITIES,
  feetInchesToCm,
  type BodyType,
  type DatingProfile,
  type Dealbreaker,
  type SeekingTrait,
} from '../types/profile'
import type { PromptAnswer, SparkProfile } from '../types/dualProfile'
import { computeSparkCompleteness } from '../types/scorecard'
import {
  parseBirthday,
  type ConflictStyle,
  type OnboardingDraft,
  type StressResponse,
  type TogethernessStyle,
} from '../components/onboarding/types'

// ─── Legal acceptance ────────────────────────────────────────────────────────

export const CONSENT_IDS = ['age', 'terms', 'privacy', 'matching', 'conduct', 'safety'] as const
export type ConsentId = (typeof CONSENT_IDS)[number]

export async function recordLegalAcceptance(uid: string): Promise<void> {
  await setDoc(doc(db, `users/${uid}/legalAcceptance/main`), {
    uid,
    acceptedAt: serverTimestamp(),
    mode: 'main',
    consentsAccepted: [...CONSENT_IDS],
  })
}

// ─── Document shapes ─────────────────────────────────────────────────────────

// Trust/safety fields. Firestore rules reject any client create or update that
// includes them — only Cloud Functions (admin SDK) may set them.
type ServerOnlyField = 'isSuspended' | 'reportCount' | 'verificationStatus' | 'subscriptionTier'

interface GoDeeperFields {
  conflictStyle?: ConflictStyle
  togethernessStyle?: TogethernessStyle
  stressResponse?: StressResponse
}

// Root fields the web writes on every save, beyond DatingProfile. Mirrors the
// mobile onboarding finish(): onboardingComplete gates AuthGuard/mobile
// routing, and a changed profileUpdatedAt triggers onProfileWrite rescoring.
interface OnboardingMetaFields {
  sparkVisibility: 'active' | 'hidden'
  onboardingComplete: true
  profileUpdatedAt: FieldValue
  mode: 'spark' | 'play'
  aiPhotoScanningConsent: boolean
}

type RootProfileDoc = Omit<DatingProfile, ServerOnlyField> & GoDeeperFields & OnboardingMetaFields

// Optional root fields: written only when answered, deleted on re-onboarding
// when cleared, never written as null.
type OptionalRootField =
  | 'genderSelfDescribe'
  | 'pronouns'
  | 'bodyType'
  | 'drinkingHabit'
  | 'religion'
  | 'politicalView'
  | 'parentalCurrent'
  | 'parentalIntent'
  | 'bioGeneratedAt'
  | keyof GoDeeperFields

type OptionalRootFields = Pick<RootProfileDoc, OptionalRootField>

const OPTIONAL_ROOT_FIELDS: OptionalRootField[] = [
  'genderSelfDescribe',
  'pronouns',
  'bodyType',
  'drinkingHabit',
  'religion',
  'politicalView',
  'parentalCurrent',
  'parentalIntent',
  'bioGeneratedAt',
  'conflictStyle',
  'togethernessStyle',
  'stressResponse',
]

// Private, owner-only doc at users/{uid}/seekingPreferences/prefs.
export interface SeekingPreferencesDoc {
  uid: string
  seekingBodyTypes: BodyType[]
  seekingTraits: SeekingTrait[]
  dealbreakers: Dealbreaker[]
  seekingHeightNoPreference: boolean
  seekingHeightMinCm?: number
  seekingHeightMaxCm?: number
  _lastUpdated: number
}

type SparkProfileDoc = Partial<SparkProfile> & { sparkPromptAnswers: Record<string, string> }

// ─── Photos ──────────────────────────────────────────────────────────────────

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

// ─── Save ────────────────────────────────────────────────────────────────────

function required<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`Onboarding incomplete: ${field}`)
  return value
}

// Uploads photos, then writes the root profile, Spark profile and private
// seeking prefs in a single batch so the user never ends up half-onboarded.
export async function saveSparkOnboarding(uid: string, d: OnboardingDraft): Promise<void> {
  const birthday = parseBirthday(d.birthdayRaw)
  if (!birthday) throw new Error('Onboarding incomplete: birthday')
  const genderIdentity = required(d.genderIdentity, 'genderIdentity')
  const relationshipStatus = required(d.relationshipStatus, 'relationshipStatus')
  const intent = required(d.intent, 'intent')

  const promptAnswers: PromptAnswer[] = d.selectedPromptIds
    .map((promptId) => ({ promptId, answer: (d.promptAnswers[promptId] ?? '').trim() }))
    .filter((p) => p.answer)
  const sparkPromptAnswers = Object.fromEntries(promptAnswers.map((p) => [p.promptId, p.answer]))
  const heightCm = feetInchesToCm(d.height.feet, d.height.inches)
  const bio = d.bio.trim()

  const { refs, urls: photoURLs } = await uploadPhotos(uid, d.photos.map((p) => p.file))

  try {
    const now = Date.now()
    const rootRef = doc(db, 'users', uid)
    const existing = await getDoc(rootRef)

    const coreFields = {
      uid,
      displayName: d.displayName.trim(),
      age: birthday.age,
      birthday: birthday.iso,
      genderIdentity,
      attractedTo: d.attractedTo,
      relationshipStatus,
      openTo: d.openTo,
      heightCm,
      lifestyleTags: d.lifestyleTags,
      habitTags: d.habitTags,
      personalityTraits: d.personalityTraits,
      relationshipValues: d.relationshipValues,
      weekendVibes: d.weekendVibes,
      loveLangGive: d.loveLangGive,
      loveLangReceive: d.loveLangReceive,
      promptAnswers,
      photoURLs,
      intent,
      radiusMiles: d.radiusMiles,
      ageMin: d.ageMin,
      ageMax: d.ageMax,
      lastActive: now,
    } satisfies Partial<RootProfileDoc>

    const optional: Partial<OptionalRootFields> = {
      ...(genderIdentity === 'self_describe' && d.genderSelfDescribe.trim() && {
        genderSelfDescribe: d.genderSelfDescribe.trim(),
      }),
      ...(d.pronouns.trim() && { pronouns: d.pronouns.trim() }),
      ...(d.bodyType && { bodyType: d.bodyType }),
      ...(d.drinkingHabit && { drinkingHabit: d.drinkingHabit }),
      ...(d.religion && { religion: d.religion }),
      ...(d.politicalView && { politicalView: d.politicalView }),
      ...(d.parentalCurrent && { parentalCurrent: d.parentalCurrent }),
      ...(d.parentalIntent && { parentalIntent: d.parentalIntent }),
      ...(bio && d.bioGeneratedAt !== null && { bioGeneratedAt: d.bioGeneratedAt }),
      ...(d.conflictStyle && { conflictStyle: d.conflictStyle }),
      ...(d.togethernessStyle && { togethernessStyle: d.togethernessStyle }),
      ...(d.stressResponse && { stressResponse: d.stressResponse }),
    }
    // Only off-map identities declare matchableAs. Never deleted on re-save:
    // it's identity-locked by the rules once identityLockedAt is set.
    const matchable =
      OFF_MAP_GENDER_IDENTITIES.includes(genderIdentity) && d.matchableAs.length > 0
        ? { matchableAs: d.matchableAs }
        : {}
    const meta: OnboardingMetaFields = {
      sparkVisibility: photoURLs.length > 0 ? 'active' : 'hidden',
      onboardingComplete: true,
      profileUpdatedAt: serverTimestamp(),
      mode: intent === 'play' ? 'play' : 'spark',
      aiPhotoScanningConsent: true,
    }

    const batch = writeBatch(db)

    if (existing.exists()) {
      // Merge so fields owned elsewhere (location, keys, trust fields) survive.
      // Optional answers the user cleared this time are removed.
      const deletions: Partial<Record<OptionalRootField, FieldValue>> = Object.fromEntries(
        OPTIONAL_ROOT_FIELDS.filter((k) => optional[k] === undefined).map((k) => [k, deleteField()]),
      )
      batch.set(
        rootRef,
        { ...coreFields, ...(bio && { bio }), ...optional, ...matchable, ...deletions, ...meta },
        { merge: true },
      )
    } else {
      const profile: RootProfileDoc = {
        ...coreFields,
        ...optional,
        ...matchable,
        bio,
        openToCrossover: false,
        // Seeking data lives in the private seekingPreferences doc, not here.
        seekingBodyTypes: [],
        seekingTraits: [],
        dealbreakers: [],
        geohash: '',
        locationLabel: '',
        phoneVerified: false,
        publicKey: '',
        createdAt: now,
        ...meta,
      }
      batch.set(rootRef, profile)
    }

    const spark: SparkProfileDoc = {
      uid,
      displayName: coreFields.displayName,
      age: birthday.age,
      ...(optional.pronouns && { pronouns: optional.pronouns }),
      genderIdentity,
      attractedTo: d.attractedTo,
      photoURLs,
      ...(bio && { bio }),
      promptAnswers,
      sparkPromptAnswers,
      lifestyleTags: d.lifestyleTags,
      personalityTags: d.personalityTraits,
      topValues: d.relationshipValues,
      intent: 'spark',
      height: heightCm,
      ...(d.bodyType && { bodyType: d.bodyType }),
      radiusMiles: d.radiusMiles,
      ageMin: d.ageMin,
      ageMax: d.ageMax,
      isActive: photoURLs.length > 0,
      completeness: computeSparkCompleteness({ ...coreFields, ...optional, bio }),
      lastUpdated: now,
    }
    batch.set(doc(db, `users/${uid}/sparkProfile/data`), spark, { merge: true })

    const seeking: SeekingPreferencesDoc = {
      uid,
      seekingBodyTypes: d.seekingBodyTypes,
      seekingTraits: d.seekingTraits,
      dealbreakers: d.dealbreakers,
      seekingHeightNoPreference: d.seekingHeightNoPreference,
      ...(!d.seekingHeightNoPreference && {
        seekingHeightMinCm: feetInchesToCm(d.seekingHeightMin.feet, d.seekingHeightMin.inches),
        seekingHeightMaxCm: feetInchesToCm(d.seekingHeightMax.feet, d.seekingHeightMax.inches),
      }),
      _lastUpdated: now,
    }
    batch.set(doc(db, `users/${uid}/seekingPreferences/prefs`), seeking)

    await batch.commit()
  } catch (err) {
    await deletePhotos(refs)
    throw err
  }

  // Everything below runs after a successful commit, outside the photo
  // cleanup above — a failure here must never delete a saved profile's photos.

  // Server sets the trust/safety fields clients can't write (isSuspended etc.).
  // Awaited so the profile is discoverable before the user reaches Discover.
  // A failure leaves the profile saved; the callable is idempotent and safe
  // to retry later.
  try {
    await httpsCallable(functions, 'initUserDefaults')({})
  } catch (err) {
    console.warn('initUserDefaults failed; profile saved but may be hidden from Discover', err)
  }

  // Server-side tier elevation for women (rules block client writes to
  // subscriptionTier). Fire-and-forget: never blocks or fails the save.
  httpsCallable(functions, 'claimWomenElite')({}).catch(() => {})
}
