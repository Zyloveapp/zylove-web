import {
  deleteField,
  doc,
  getDoc,
  serverTimestamp,
  writeBatch,
  type FieldValue,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { photoProgress, uploadModeratedPhotos, type SaveProgress } from './moderatedPhotos'
import { keysReady, resolveKeypair } from './keys'
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
  answeredGoDeeper,
  INITIAL_DRAFT,
  PROMPT_COUNT,
  parseBirthday,
  type ConflictStyle,
  type HeightFtIn,
  type OnboardingDraft,
  type StressResponse,
  type TogethernessStyle,
} from '../components/onboarding/types'
import { loadOwnProfile } from './profile'
import { changeDisplayName } from './displayNames'
import { addIdentity, loadIdentity } from './privateIdentity'
import { loadPrivateProfile, privateProfileDoc } from './privateProfile'
import { genderFields, matchingDoc } from './privateMatching'
import { FieldLockedError, explainRefusal, limitedPatch, loadFieldStates, lockedChanges } from './fieldLocks'

// ─── Legal acceptance ────────────────────────────────────────────────────────

export const CONSENT_IDS = ['age', 'terms', 'privacy', 'matching', 'conduct', 'safety'] as const
export type ConsentId = (typeof CONSENT_IDS)[number]

// Recorded server-side (functions/src/legal.ts): time, IP, user agent and the
// document versions. Throws if the server can't record it — onboarding
// doesn't move on without a record.
export async function recordLegalAcceptance(): Promise<void> {
  await httpsCallable(functions, 'recordTermsAcceptance')({ consents: [...CONSENT_IDS] })
}

// ─── Document shapes ─────────────────────────────────────────────────────────

// Server-only or private fields. Firestore rules reject any client create or
// update of users/{uid} that includes them — Cloud Functions set them, or
// they live in the user's private docs (services/privateIdentity.ts …).
type ServerOnlyField =
  | 'isSuspended'
  | 'reportCount'
  | 'verificationStatus'
  | 'subscriptionTier'
  | 'geohash'
  | 'lastActive'
  | 'birthday'
  // Stage 2: owner-only (private/profile) — they'd reveal Play use.
  | 'intent'
  | 'openToCrossover'
  // Stage 3: owner-only (private/matching).
  | 'attractedTo'
  | 'matchableAs'
  | 'radiusMiles'
  | 'ageMin'
  | 'ageMax'
  | 'drinkingHabit'
  | 'seekingBodyTypes'
  | 'seekingTraits'
  | 'dealbreakers'
  // §4.A2: owner-only (private/matching); others see the server's genderLine.
  | 'genderIdentity'
  | 'genderSelfDescribe'
  | 'pronouns'
  | 'genderHidden'
  | 'showGender'
  | 'genderLine'

interface GoDeeperFields {
  conflictStyle?: ConflictStyle
  togethernessStyle?: TogethernessStyle
  stressResponse?: StressResponse
}

// Root fields the web writes on every save, beyond DatingProfile. Mirrors the
// mobile onboarding finish(): onboardingComplete gates AuthGuard/mobile
// routing, and a changed profileUpdatedAt triggers onProfileWrite rescoring.
interface OnboardingMetaFields {
  sparkVisibility: 'active' | 'hidden' | 'paused'
  onboardingComplete: true
  profileUpdatedAt: FieldValue
}

type RootProfileDoc = Omit<DatingProfile, ServerOnlyField> & GoDeeperFields & OnboardingMetaFields

// Optional root fields: written only when answered, deleted on re-onboarding
// when cleared, never written as null.
type OptionalRootField =
  | 'heightCm'
  | 'bodyType'
  | 'parentalCurrent'
  | 'parentalIntent'
  | 'bioGeneratedAt'
  | keyof GoDeeperFields

type OptionalRootFields = Pick<RootProfileDoc, OptionalRootField>

const OPTIONAL_ROOT_FIELDS: OptionalRootField[] = [
  'heightCm',
  'bodyType',
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
  seekingBodyNoPreference?: boolean
  // null = "Doesn't matter" (no body-type filter in matching).
  bodyTypePreference?: null
  seekingHeightMinCm?: number
  seekingHeightMaxCm?: number
  _lastUpdated: number
}

type SparkProfileDoc = Partial<SparkProfile> & { sparkPromptAnswers: Record<string, string> }

// ─── Photos ──────────────────────────────────────────────────────────────────
// New photos are uploaded after the profile is saved, through moderation
// (moderatedPhotos.ts): onPhotoUpload can only update an existing doc, and
// only it publishes photo URLs.

// ─── Save ────────────────────────────────────────────────────────────────────

function required<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`Onboarding incomplete: ${field}`)
  return value
}

// Writes the root profile, Spark profile and private seeking prefs in a single
// batch so the user never ends up half-onboarded, then sends new photos
// through moderation. Resolves with notices for photos that didn't publish
// (under review, slow, failed) — empty when they all passed.
// extraPrompts: saved prompts beyond the PROMPT_COUNT a refresh shows. They're
// kept as-is unless the draft now uses the same prompt.
export async function saveSparkOnboarding(
  uid: string,
  d: OnboardingDraft,
  // newSparkProfile: a Play-only account building its first Spark profile —
  // the 'hidden' Spark visibility it had while Play-only isn't a choice to keep.
  // onProgress: what the save is doing, for the button label.
  {
    extraPrompts = [],
    newSparkProfile = false,
    onProgress,
  }: { extraPrompts?: PromptAnswer[]; newSparkProfile?: boolean; onProgress?: SaveProgress } = {},
): Promise<string[]> {
  onProgress?.('Saving your profile…')
  const rootRef = doc(db, 'users', uid)
  const existing = await getDoc(rootRef)
  // Once identity is locked the rules reject any change to birthday,
  // genderIdentity or matchableAs, so a re-save leaves them untouched.
  const identityLocked = existing.data()?.identityLockedAt != null
  const existingAge: unknown = existing.data()?.age
  const birthday = parseBirthday(d.birthdayRaw)
  const age = birthday?.age ?? (identityLocked && typeof existingAge === 'number' ? existingAge : null)
  if (age === null) throw new Error('Onboarding incomplete: birthday')
  const genderIdentity = required(d.genderIdentity, 'genderIdentity')
  const relationshipStatus = required(d.relationshipStatus, 'relationshipStatus')
  const intent = required(d.intent, 'intent')

  const promptAnswers: PromptAnswer[] = [
    ...d.selectedPromptIds.map((promptId) => ({ promptId, answer: (d.promptAnswers[promptId] ?? '').trim() })),
    ...extraPrompts.filter((p) => !d.selectedPromptIds.includes(p.promptId)),
  ].filter((p) => p.answer)
  const sparkPromptAnswers = Object.fromEntries(promptAnswers.map((p) => [p.promptId, p.answer]))
  // F-018: height is optional; none given = no height on the profile.
  const heightCm = d.height ? feetInchesToCm(d.height.feet, d.height.inches) : null
  const bio = d.bio.trim()

  // Only already-published photos (profile refresh) are written here; new
  // ones go through moderation after the commit.
  const photoURLs = d.photos.filter((p) => p.file === null).map((p) => p.previewUrl)
  const newPhotos = d.photos.map((p) => p.file).filter((f): f is File => f !== null)
  const hasPhotos = d.photos.length > 0

  const now = Date.now()

  // Private key goes to IndexedDB now; the public key rides in the batch below.
  await keysReady(uid)
  const existingKey: unknown = existing.data()?.publicKey
  const keys = await resolveKeypair(uid, typeof existingKey === 'string' ? existingKey : undefined)

  // Once set, the display name changes only through updateDisplayName (the
  // rules refuse a direct change); a refresh that renames saves the rest with
  // the old name and asks the callable after.
  const newName = d.displayName.trim()
  const priorName: unknown = existing.data()?.displayName
  const renaming = typeof priorName === 'string' && priorName !== '' && priorName !== newName

  const coreFields = {
    uid,
    displayName: renaming ? priorName : newName,
    age,
    relationshipStatus,
    openTo: d.openTo,
    lifestyleTags: d.lifestyleTags,
    habitTags: d.habitTags,
    personalityTraits: d.personalityTraits,
    relationshipValues: d.relationshipValues,
    weekendVibes: d.weekendVibes,
    loveLangGive: d.loveLangGive,
    loveLangReceive: d.loveLangReceive,
    promptAnswers,
    photoURLs,
  } satisfies Partial<RootProfileDoc>
  // F-099: attraction, drinking, religion, politics and the intent change
  // once every 30 days — only the ones that really change are written (with
  // their stamp), and a locked one stops the save with its date.
  // F-018: religion and politics are never shown — owner-only in
  // private/matching, not on the public doc (the rules refuse them there).
  const limited = {
    attractedTo: d.attractedTo,
    drinkingHabit: d.drinkingHabit,
    religion: d.religion,
    politicalView: d.politicalView,
  }
  const fieldStates = await loadFieldStates(uid)
  const locked = lockedChanges(fieldStates, { ...limited, intent })
  if (locked.length > 0) throw new FieldLockedError(locked)
  // Matching preferences: owner-only (private/matching, Stage 3).
  const matching = {
    radiusMiles: d.radiusMiles,
    ageMin: d.ageMin,
    ageMax: d.ageMax,
    ...limitedPatch(fieldStates, limited),
    ...genderFields(d, genderIdentity, identityLocked),
  }

  const optional: Partial<OptionalRootFields> = {
    ...(heightCm !== null && { heightCm }),
    ...(d.bodyType && { bodyType: d.bodyType }),
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
    !identityLocked && OFF_MAP_GENDER_IDENTITIES.includes(genderIdentity) && d.matchableAs.length > 0
      ? { matchableAs: d.matchableAs }
      : {}
  // A re-save (profile refresh) keeps a hidden/paused choice the user made.
  const prevVisibility: unknown = existing.data()?.sparkVisibility
  const meta: OnboardingMetaFields = {
    sparkVisibility:
      !hasPhotos
        ? 'hidden'
        : !newSparkProfile && (prevVisibility === 'hidden' || prevVisibility === 'paused')
          ? prevVisibility
          : 'active',
    onboardingComplete: true,
    profileUpdatedAt: serverTimestamp(),
  }

  // Owner-only (private/profile, Stage 2): which modes, the current mode and
  // the intention answers — the intention ones on the first onboarding only
  // (a refresh leaves the original answers alone).
  const privateMeta = {
    ...limitedPatch(fieldStates, { intent }),
    mode: intent === 'play' ? 'play' : 'spark',
    ...(d.onboardingPath !== null && { intentionAnswers: d.intentionAnswers, onboardingPath: d.onboardingPath }),
  }

  // Spark Go Deeper answers (answered ones only), on the root and Spark docs.
  const goDeeper = { goDeeper: answeredGoDeeper(d) }

  const batch = writeBatch(db)

  if (existing.exists()) {
    // Merge so fields owned elsewhere (location, keys, trust fields) survive.
    // Optional answers the user cleared this time are removed.
    const deletions: Partial<Record<OptionalRootField, FieldValue>> = Object.fromEntries(
      OPTIONAL_ROOT_FIELDS.filter((k) => optional[k] === undefined).map((k) => [k, deleteField()]),
    )
    batch.set(
      rootRef,
      {
        ...coreFields,
        ...(bio && { bio }),
        ...optional,
        ...deletions,
        ...(keys.changed && { publicKey: keys.publicKey }),
        ...goDeeper,
        ...meta,
      },
      { merge: true },
    )
  } else {
    if (!birthday) throw new Error('Onboarding incomplete: birthday')
    const profile: RootProfileDoc = {
      ...coreFields,
      ...optional,
      bio,
      locationLabel: '',
      phoneVerified: false,
      publicKey: keys.publicKey,
      createdAt: now,
      ...goDeeper,
      ...meta,
    }
    batch.set(rootRef, profile)
  }
  batch.set(privateProfileDoc(uid), privateMeta, { merge: true })
  batch.set(matchingDoc(uid), { ...matching, ...matchable }, { merge: true })

  const spark: SparkProfileDoc = {
    uid,
    displayName: coreFields.displayName,
    age,
    photoURLs,
    ...(bio && { bio }),
    promptAnswers,
    sparkPromptAnswers,
    lifestyleTags: d.lifestyleTags,
    personalityTags: d.personalityTraits,
    topValues: d.relationshipValues,
    intent: 'spark',
    ...(heightCm !== null && { height: heightCm }),
    ...(d.bodyType && { bodyType: d.bodyType }),
    isActive: hasPhotos,
    completeness: computeSparkCompleteness({ ...coreFields, ...optional, bio, pronouns: d.pronouns.trim() }),
    lastUpdated: now,
  }
  const sparkRef = doc(db, `users/${uid}/sparkProfile/data`)
  batch.set(sparkRef, spark, { merge: true })
  // A height removed on this save goes from the Spark doc too.
  if (heightCm === null) batch.set(sparkRef, { height: deleteField() }, { merge: true })
  // set+merge merges map keys, so a prompt swapped out would linger in
  // sparkPromptAnswers (which loadOwnProfile prefers). Replace the map whole.
  batch.update(sparkRef, { sparkPromptAnswers, ...goDeeper })

  const seeking: SeekingPreferencesDoc = {
    uid,
    seekingBodyTypes: d.seekingBodyNoPreference ? [] : d.seekingBodyTypes,
    seekingBodyNoPreference: d.seekingBodyNoPreference,
    ...(d.seekingBodyNoPreference && { bodyTypePreference: null }),
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
  // Owner-only (users/{uid}/private/identity): legal name once, birthday
  // until identity is locked.
  await addIdentity(batch, uid, d.legalName, !identityLocked && birthday ? birthday.iso : null)

  await batch.commit().catch(async (err) => {
    throw await explainRefusal(uid, { ...limited, intent }, err)
  })

  // Everything below runs after a successful commit.

  // Server sets the trust/safety fields clients can't write (isSuspended etc.).
  // Awaited so the profile is discoverable before the user reaches Discover.
  // A failure leaves the profile saved; the callable is idempotent and safe
  // to retry later.
  onProgress?.('Setting up your account…')
  try {
    await httpsCallable(functions, 'initUserDefaults')({})
  } catch (err) {
    console.warn('initUserDefaults failed; profile saved but may be hidden from Discover', err)
  }

  // Server-side tier elevation for women (rules block client writes to
  // subscriptionTier). Fire-and-forget: never blocks or fails the save.
  httpsCallable(functions, 'claimWomenElite')({}).catch(() => {})

  // Discover also requires a published photo, so the profile only shows up
  // once moderation passes one.
  const { notices } = await uploadModeratedPhotos(uid, 'spark', newPhotos, photoProgress(onProgress))
  const nameError = renaming ? await changeDisplayName('spark', newName) : null
  return nameError ? [...notices, nameError] : notices
}

// ─── Profile refresh ─────────────────────────────────────────────────────────

function str<T extends string>(v: unknown): T | null {
  return typeof v === 'string' && v !== '' ? (v as T) : null
}

function arr<T extends string>(v: unknown): T[] {
  return Array.isArray(v) ? v.filter((x): x is T => typeof x === 'string' && x !== '') : []
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function cmToHeight<T extends HeightFtIn | null>(cm: unknown, fallback: T): HeightFtIn | T {
  if (typeof cm !== 'number' || cm <= 0) return fallback
  const total = Math.round(cm / 2.54)
  return { feet: Math.floor(total / 12), inches: total % 12 }
}

// Stored as ISO YYYY-MM-DD; the draft uses MM/DD/YYYY.
function isoToBirthdayRaw(v: unknown): string {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null
  return m ? `${m[2]}/${m[3]}/${m[1]}` : ''
}

export interface RefreshDraft {
  draft: OnboardingDraft
  // Prompts beyond the PROMPT_COUNT the flow shows; pass back to the save.
  extraPrompts: PromptAnswer[]
  // Birthday and gender can't change once locked (see saveSparkOnboarding).
  identityLocked: boolean
}

// Rebuilds an onboarding draft from the saved profile for "Reimagine my
// profile". Terms count as accepted; photos are kept as their stored URLs.
export async function loadRefreshDraft(uid: string): Promise<RefreshDraft | null> {
  const [own, seekingSnap] = await Promise.all([
    loadOwnProfile(uid),
    getDoc(doc(db, `users/${uid}/seekingPreferences/prefs`)).catch(() => null),
  ])
  if (!own) return null
  const p = own.profile as Record<string, unknown>
  const { legalName, birthday } = await loadIdentity(uid, p.birthday)
  const s = seekingSnap?.data() ?? {}
  const prompts = own.prompts.slice(0, PROMPT_COUNT)
  const rawGender: unknown = Array.isArray(p.genderIdentity) ? p.genderIdentity[0] : p.genderIdentity
  const weekend = arr<OnboardingDraft['weekendVibes'][number]>(p.weekendVibes)
  const minCm: unknown = s.seekingHeightMinCm
  const maxCm: unknown = s.seekingHeightMaxCm

  const draft: OnboardingDraft = {
    ...INITIAL_DRAFT,
    termsAccepted: true,
    legalName: legalName ?? '',
    displayName: str(p.displayName) ?? '',
    birthdayRaw: isoToBirthdayRaw(birthday),
    photos: arr(p.photoURLs).map((url) => ({ id: crypto.randomUUID(), file: null, previewUrl: url })),
    genderIdentity: str(rawGender),
    genderSelfDescribe: str(p.genderSelfDescribe) ?? '',
    matchableAs: arr(p.matchableAs),
    pronouns: str(p.pronouns) ?? '',
    genderHidden: p.genderHidden === true,
    showGender: p.showGender === true,
    attractedTo: arr(p.attractedTo),
    relationshipStatus: str(p.relationshipStatus),
    openTo: arr(p.openTo),
    bodyType: str(p.bodyType),
    height: cmToHeight(p.heightCm, null),
    lifestyleTags: arr(p.lifestyleTags),
    habitTags: arr(p.habitTags),
    drinkingHabit: str(p.drinkingHabit),
    personalityTraits: arr(p.personalityTraits),
    relationshipValues: arr(p.relationshipValues),
    // Older profiles stored a single weekendVibe.
    weekendVibes: weekend.length > 0 ? weekend : arr([p.weekendVibe]),
    loveLangGive: arr(p.loveLangGive),
    loveLangReceive: arr(p.loveLangReceive),
    religion: str(p.religion),
    politicalView: str(p.politicalView),
    parentalCurrent: str(p.parentalCurrent),
    parentalIntent: str(p.parentalIntent),
    seekingHeightNoPreference: s.seekingHeightNoPreference !== false,
    seekingBodyNoPreference: s.seekingBodyNoPreference === true,
    sparkGoDeeper: Array.isArray(p.goDeeper)
      ? (p.goDeeper as { question?: unknown; answer?: unknown }[])
          .filter((g) => typeof g?.question === 'string' && typeof g?.answer === 'string')
          .map((g) => ({ question: g.question as string, answer: g.answer as string }))
      : [],
    seekingHeightMin: cmToHeight(minCm, INITIAL_DRAFT.seekingHeightMin),
    seekingHeightMax: cmToHeight(maxCm, INITIAL_DRAFT.seekingHeightMax),
    seekingBodyTypes: arr(s.seekingBodyTypes),
    seekingTraits: arr(s.seekingTraits),
    // Root dealbreakers (mobile) plus the private prefs (web).
    dealbreakers: arr(own.dealbreakers),
    intent: str((await loadPrivateProfile(uid, p)).intent),
    // Stage C: 1–100 miles; an old "no limit" becomes 100.
    radiusMiles: p.radiusMiles === null ? 100 : Math.min(num(p.radiusMiles, INITIAL_DRAFT.radiusMiles ?? 25), 100),
    ageMin: num(p.ageMin, INITIAL_DRAFT.ageMin),
    ageMax: num(p.ageMax, INITIAL_DRAFT.ageMax),
    selectedPromptIds: prompts.map((q) => q.promptId),
    promptAnswers: Object.fromEntries(prompts.map((q) => [q.promptId, q.answer])),
    conflictStyle: str(p.conflictStyle),
    togethernessStyle: str(p.togethernessStyle),
    stressResponse: str(p.stressResponse),
    bio: own.bio,
    bioGeneratedAt: typeof p.bioGeneratedAt === 'number' ? p.bioGeneratedAt : null,
  }
  return { draft, extraPrompts: own.prompts.slice(PROMPT_COUNT), identityLocked: p.identityLockedAt != null }
}
