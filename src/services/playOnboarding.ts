import { doc, getDoc, writeBatch } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { db, functions } from './firebase'
import { photoProgress, uploadModeratedPhotos, type SaveProgress } from './moderatedPhotos'
import { keysReady, publishMyPlayKey, resolveKeypair } from './keys'
import { getUserTier, isAlwaysElite, loadAccountView } from './subscription'
import { changeDisplayName } from './displayNames'
import { addIdentity } from './privateIdentity'
import { OFF_MAP_GENDER_IDENTITIES } from '../types/profile'
import {
  PLAY_PROMPT_BANK,
  PLAY_TAG_LABELS,
  SPICE_META,
  selectPlayPrompts,
  type PlayInterestTag,
  type PlayNonNegotiable,
  type SpiceLevel,
} from '../types/dualProfile'
import {
  EMPTY_TYPE_PREFERENCES,
  PLAY_BODY_HAIR_LABELS,
  PLAY_BODY_TYPE_LABELS,
  PLAY_ENERGY_LABELS,
  PLAY_GROOMING_LABELS,
  parseTypePreferences,
  type PlayBodyHair,
  type PlayBodyType,
  type PlayEnergy,
  type PlayGrooming,
  type TypePreferences,
} from '../types/playDescriptors'
import { parseBirthday, type OnboardingDraft, type PhotoDraft } from '../components/onboarding/types'
import { loadPrivateProfile, privateProfileDoc } from './privateProfile'
import { genderFields, matchingDoc, matchingPatch } from './privateMatching'
import { explainRefusal, limitedPatch, loadFieldStates } from './fieldLocks'

export type PlayTagCategory = 'arrangement' | 'acts' | 'dynamic' | 'vibe' | 'place'

export interface PlayDraft {
  photos: PhotoDraft[]
  // The name shown on the Play profile (falls back to displayName when empty).
  playDisplayName: string
  bio: string
  spiceLevel: SpiceLevel | null
  // Every selected tag, across all five categories.
  tags: PlayInterestTag[]
  nonNegotiables: PlayNonNegotiable[]
  // The prompts shown (three seeded per user, swappable, up to five) and
  // their answers.
  promptIds: string[]
  answers: Record<string, string>
  // "A little about you" — all optional. Height in cm.
  bodyType: PlayBodyType | null
  heightCm: number | null
  bodyHair: PlayBodyHair | null
  grooming: PlayGrooming | null
  energy: PlayEnergy | null
  typePreferences: TypePreferences
  // The two AI-written Go Deeper questions and their (optional) answers.
  goDeeper: GoDeeperAnswer[]
}

export interface GoDeeperAnswer {
  question: string
  answer: string
}

export const MIN_PLAY_ANSWERS = 3
export const MAX_PLAY_PROMPTS = 5

export function emptyPlayDraft(uid: string): PlayDraft {
  return {
    photos: [],
    playDisplayName: '',
    bio: '',
    spiceLevel: null,
    tags: [],
    nonNegotiables: [],
    promptIds: selectPlayPrompts(uid).map((p) => p.id),
    answers: {},
    bodyType: null,
    heightCm: null,
    bodyHair: null,
    grooming: null,
    energy: null,
    typePreferences: EMPTY_TYPE_PREFERENCES,
    goDeeper: [],
  }
}

export function tagsIn(tags: PlayInterestTag[], category: PlayTagCategory): PlayInterestTag[] {
  return tags.filter((t) => PLAY_TAG_LABELS[t]?.category === category)
}

export function answeredPrompts(d: PlayDraft): { promptId: string; answer: string }[] {
  return d.promptIds
    .map((promptId) => ({ promptId, answer: (d.answers[promptId] ?? '').trim() }))
    .filter((p) => p.answer)
}

export function answeredGoDeeper(d: PlayDraft): GoDeeperAnswer[] {
  return d.goDeeper.map((g) => ({ question: g.question, answer: g.answer.trim() })).filter((g) => g.answer)
}

// Standard prompts and Go Deeper together count toward the gate.
export function playAnswerCount(d: PlayDraft): number {
  return answeredPrompts(d).length + answeredGoDeeper(d).length
}

function promptText(id: string): string {
  return PLAY_PROMPT_BANK.find((p) => p.id === id)?.text ?? id
}

// The about-you and type fields as saved on playProfile/data and mirrored to
// the root doc. Unset values are null so an edit can clear them.
export function descriptorFields(d: PlayDraft) {
  return {
    playBodyType: d.bodyType,
    playHeight: d.heightCm,
    playBodyHair: d.bodyHair,
    playGrooming: d.grooming,
    playEnergy: d.energy,
    typePreferences: d.typePreferences,
  }
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
      ...descriptorFields(d),
      goDeeper: answeredGoDeeper(d),
    })
    const bio = data.bio?.trim()
    return bio ? { bio } : { error: 'failed' }
  } catch (err) {
    return { error: err instanceof FirebaseError && err.code === 'functions/resource-exhausted' ? 'limit' : 'failed' }
  }
}

// ─── Go Deeper ───────────────────────────────────────────────────────────────

export type GoDeeperResult = { questions: string[] } | { error: 'limit' | 'failed' }

// Two questions written from everything answered so far (generatePlayGoDeeper,
// 3 per rolling week). The standard prompt answers go along as context.
export async function generatePlayGoDeeper(d: PlayDraft): Promise<GoDeeperResult> {
  try {
    const { data } = await httpsCallable<object, { questions?: unknown }>(functions, 'generatePlayGoDeeper', {
      timeout: 60_000,
    })({
      spiceLevel: d.spiceLevel,
      spiceDescription: d.spiceLevel ? SPICE_META[d.spiceLevel].description : null,
      arrangementTags: tagsIn(d.tags, 'arrangement'),
      dynamicTags: tagsIn(d.tags, 'dynamic'),
      vibeTags: tagsIn(d.tags, 'vibe'),
      actsTags: tagsIn(d.tags, 'acts'),
      nonNegotiables: d.nonNegotiables,
      ...descriptorFields(d),
      existingPromptAnswers: answeredPrompts(d).map((p) => ({ question: promptText(p.promptId), answer: p.answer })),
    })
    const questions = Array.isArray(data.questions)
      ? data.questions.filter((q): q is string => typeof q === 'string' && q.trim() !== '')
      : []
    return questions.length === 2 ? { questions } : { error: 'failed' }
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
// Play profile data lives only in playProfile/data (Stage 2: nothing Play on
// the public doc); the intent in the owner-only private/profile. Editing
// (keepIntent) leaves the intent alone: a Play-only user must not be
// switched to 'open' just by updating their Play profile.
// onProgress: what the save is doing, for the button label.
export async function savePlayOnboarding(
  uid: string,
  d: PlayDraft,
  { keepIntent = false, onProgress }: { keepIntent?: boolean; onProgress?: SaveProgress } = {},
): Promise<string[]> {
  onProgress?.('Saving your Play profile…')
  const prompts = answeredPrompts(d)
  const bio = d.bio.trim()
  // Only already-published photos (editing) are written here.
  const photoURLs = d.photos.filter((p) => p.file === null).map((p) => p.previewUrl)
  const newPhotos = d.photos.map((p) => p.file).filter((f): f is File => f !== null)

  const playRef = doc(db, `users/${uid}/playProfile/data`)
  const [existing, root, fieldStates] = await Promise.all([
    getDoc(playRef),
    getDoc(doc(db, 'users', uid)),
    keepIntent ? null : loadFieldStates(uid),
  ])
  // F-099: the intent changes once every 30 days — adding Play ('open') is
  // a change unless it already is; a locked one stops here with its date.
  const intentPatch = fieldStates ? limitedPatch(fieldStates, { intent: 'open' }) : {}
  const now = Date.now()
  // The first Play name is written directly; changing it afterwards goes
  // through updateDisplayName (30-day limit — the rules refuse a direct
  // change), after the rest is saved.
  const priorName: unknown = existing.data()?.playDisplayName ?? root.data()?.playDisplayName
  const playName = d.playDisplayName.trim()
  const renaming = typeof priorName === 'string' && priorName !== '' && priorName !== playName
  const nameFields = playName && !renaming ? { playDisplayName: playName } : {}
  const batch = writeBatch(db)
  batch.set(
    playRef,
    {
      uid,
      photoURLs,
      ...nameFields,
      playBio: bio,
      spiceLevel: d.spiceLevel,
      playInterestTags: d.tags,
      playNonNegotiables: d.nonNegotiables,
      playPromptAnswers: Object.fromEntries(prompts.map((p) => [p.promptId, p.answer])),
      promptAnswers: prompts,
      ...descriptorFields(d),
      goDeeper: answeredGoDeeper(d),
      playOnboardingComplete: true,
      aiPhotoScanningConsent: true,
      isActive: d.photos.length > 0,
      lastUpdated: now,
      ...(!existing.exists() && { createdAt: now }),
    },
    { merge: true },
  )
  if (Object.keys(intentPatch).length > 0) batch.set(privateProfileDoc(uid), intentPatch, { merge: true })
  await batch.commit().catch(async (err) => {
    throw keepIntent ? err : await explainRefusal(uid, { intent: 'open' }, err)
  })

  const { notices } = await uploadModeratedPhotos(uid, 'play', newPhotos, photoProgress(onProgress))
  // F-062: the Play chat key, now there's a Play profile to put it on.
  void publishMyPlayKey(uid).catch(() => {})
  const nameError = renaming ? await changeDisplayName('play', playName) : null
  return nameError ? [...notices, nameError] : notices
}

// Play-only onboarding (the Play path in /onboarding): no Spark profile. The
// root doc gets identity and the minimum Spark fields scoring expects, hidden
// from Spark — nothing Play (Stage 2): the Play profile goes to
// playProfile/data, the path/mode/intent to the owner-only private/profile,
// the discovery settings to the owner-only private/matching (Stage 3).
// Trust/trial fields come from initUserDefaults (rules reject client writes
// to them).

export async function savePlayOnlyOnboarding(
  uid: string,
  d: OnboardingDraft,
  play: PlayDraft,
  onProgress?: SaveProgress,
): Promise<string[]> {
  onProgress?.('Saving your profile…')
  const rootRef = doc(db, 'users', uid)
  const playRef = doc(db, `users/${uid}/playProfile/data`)
  const [existing, existingPlay] = await Promise.all([getDoc(rootRef), getDoc(playRef)])
  const data = existing.data()
  // Once identity is locked the rules reject any change to birthday,
  // genderIdentity or matchableAs, so a re-save leaves them untouched.
  const identityLocked = data?.identityLockedAt != null
  const birthday = parseBirthday(d.birthdayRaw)
  const age = birthday?.age ?? (identityLocked && typeof data?.age === 'number' ? data.age : null)
  if (age === null) throw new Error('Onboarding incomplete: birthday')
  const genderIdentity = d.genderIdentity
  if (genderIdentity === null) throw new Error('Onboarding incomplete: genderIdentity')

  const prompts = answeredPrompts(play)
  const bio = play.bio.trim()
  const newPhotos = d.photos.map((p) => p.file).filter((f): f is File => f !== null)
  const now = Date.now()
  // F-099: attraction and the intent change once every 30 days (a returning
  // account may have them already); a locked one stops here with its date.
  const limited = { attractedTo: d.attractedTo, intent: 'open' }
  const fieldStates = await loadFieldStates(uid)
  limitedPatch(fieldStates, limited)

  // Private key goes to IndexedDB now; the public key rides in the batch below.
  await keysReady(uid)
  const keys = await resolveKeypair(uid, typeof data?.publicKey === 'string' ? data.publicKey : undefined)

  // Names already set change only through updateDisplayName (see
  // savePlayOnboarding); first ones are written here.
  const sparkName = d.displayName.trim()
  const priorSparkName: unknown = data?.displayName
  const renamingSpark = typeof priorSparkName === 'string' && priorSparkName !== '' && priorSparkName !== sparkName
  const playName = play.playDisplayName.trim()
  const priorPlayName: unknown = existingPlay.data()?.playDisplayName ?? data?.playDisplayName
  const renamingPlay = typeof priorPlayName === 'string' && priorPlayName !== '' && priorPlayName !== playName

  const batch = writeBatch(db)
  batch.set(
    rootRef,
    {
      uid,
      ...(!renamingSpark && { displayName: sparkName }),
      age,
      relationshipStatus: 'prefer_not_to_say',
      openTo: [],
      onboardingComplete: true,
      sparkVisibility: 'hidden',
      ...((keys.changed || !existing.exists()) && { publicKey: keys.publicKey }),
      ...(!existing.exists() && { photoURLs: [], locationLabel: '', phoneVerified: false, createdAt: now }),
    },
    { merge: true },
  )
  batch.set(
    playRef,
    {
      uid,
      ...(playName && !renamingPlay && { playDisplayName: playName }),
      playBio: bio,
      spiceLevel: play.spiceLevel,
      playInterestTags: play.tags,
      playNonNegotiables: play.nonNegotiables,
      playPromptAnswers: Object.fromEntries(prompts.map((p) => [p.promptId, p.answer])),
      promptAnswers: prompts,
      ...descriptorFields(play),
      goDeeper: answeredGoDeeper(play),
      playOnboardingComplete: true,
      aiPhotoScanningConsent: true,
      isActive: d.photos.length > 0,
      lastUpdated: now,
      ...(!existingPlay.exists() && { photoURLs: [], createdAt: now }),
    },
    { merge: true },
  )
  batch.set(
    privateProfileDoc(uid),
    { ...limitedPatch(fieldStates, { intent: limited.intent }), intentionAnswers: d.intentionAnswers, onboardingPath: 'play', mode: 'play' },
    { merge: true },
  )
  // Matching preferences: owner-only (private/matching, Stage 3).
  batch.set(
    matchingDoc(uid),
    {
      ...matchingPatch({
        radiusMiles: d.radiusMiles,
        ageMin: d.ageMin,
        ageMax: d.ageMax,
        ...(!identityLocked && OFF_MAP_GENDER_IDENTITIES.includes(genderIdentity) && d.matchableAs.length > 0 && { matchableAs: d.matchableAs }),
      }),
      ...limitedPatch(fieldStates, { attractedTo: limited.attractedTo }),
    },
    { merge: true },
  )
  // §4.A2: gender and pronouns are owner-only too (the server builds the
  // public genderLine from them).
  batch.set(matchingDoc(uid), genderFields(d, genderIdentity, identityLocked), { merge: true })
  // Owner-only (users/{uid}/private/identity): legal name once, birthday
  // until identity is locked.
  await addIdentity(batch, uid, d.legalName, !identityLocked && birthday ? birthday.iso : null)
  await batch.commit().catch(async (err) => {
    throw await explainRefusal(uid, limited, err)
  })

  // Server sets the trust/trial fields clients can't write (isSuspended,
  // sparkScore, subscriptionTier, trial, sortKey). Awaited so the profile is
  // discoverable before Explore; idempotent, so a failure is safe to retry.
  onProgress?.('Setting up your account…')
  try {
    await httpsCallable(functions, 'initUserDefaults')({})
  } catch (err) {
    console.warn('initUserDefaults failed; profile saved but may be hidden from Discover', err)
  }
  httpsCallable(functions, 'claimWomenElite')({}).catch(() => {})

  // playProfile/data exists now, so onPhotoUpload can publish to it.
  const { notices } = await uploadModeratedPhotos(uid, 'play', newPhotos, photoProgress(onProgress))
  void publishMyPlayKey(uid).catch(() => {})
  const nameErrors = [
    renamingSpark ? await changeDisplayName('spark', sparkName) : null,
    renamingPlay ? await changeDisplayName('play', playName) : null,
  ].filter((e): e is string => e !== null)
  return [...notices, ...nameErrors]
}

// Gets Play on a running 30-day trial rather than for free: not a founder,
// not an always-Elite gender, not already Elite, and their market has opened
// (pre-launch, Play is simply free). Read after initUserDefaults has run, so
// the trial fields reflect the server's decision.
export async function needsPlayTrialWelcome(uid: string): Promise<boolean> {
  const data = await loadAccountView(uid)
  if (!data) return false
  return !isAlwaysElite(data) && data.subscriptionTier !== 'elite' && getUserTier(data) === 'trial'
}

// Play-only: chose the Play path, finished Play, and never built a Spark
// profile. Everyone else (missing or other onboardingPath) is a Spark user.
export async function isPlayOnlyUser(uid: string): Promise<boolean> {
  if ((await loadPrivateProfile(uid)).onboardingPath !== 'play') return false
  const [play, spark] = await Promise.all([
    getDoc(doc(db, `users/${uid}/playProfile/data`)),
    getDoc(doc(db, `users/${uid}/sparkProfile/data`)),
  ])
  return play.data()?.playOnboardingComplete === true && !spark.exists()
}

// ─── Edit ────────────────────────────────────────────────────────────────────

const PROMPT_SLOTS = 3

function oneOf<T extends string>(record: Record<T, string>, v: unknown): T | null {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(record, v) ? (v as T) : null
}

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
  const promptIds = Object.keys(answers).slice(0, MAX_PLAY_PROMPTS)
  for (const id of suggested) {
    if (promptIds.length >= PROMPT_SLOTS) break
    if (!promptIds.includes(id)) promptIds.push(id)
  }

  const goDeeper: GoDeeperAnswer[] = Array.isArray(d.goDeeper)
    ? d.goDeeper
        .filter((g: unknown): g is GoDeeperAnswer => {
          const q = g as GoDeeperAnswer
          return typeof q?.question === 'string' && typeof q?.answer === 'string' && q.question.trim() !== ''
        })
        .map((g: GoDeeperAnswer) => ({ question: g.question, answer: g.answer }))
    : []

  return {
    photos: strings(d.photoURLs).map((url) => ({ id: url, file: null, previewUrl: url })),
    playDisplayName: typeof d.playDisplayName === 'string' ? d.playDisplayName : '',
    bio: typeof d.playBio === 'string' ? d.playBio : '',
    spiceLevel: typeof d.spiceLevel === 'string' ? (d.spiceLevel as SpiceLevel) : null,
    tags: strings(d.playInterestTags) as PlayInterestTag[],
    nonNegotiables: strings(d.playNonNegotiables) as PlayNonNegotiable[],
    promptIds,
    answers,
    bodyType: oneOf(PLAY_BODY_TYPE_LABELS, d.playBodyType),
    heightCm: typeof d.playHeight === 'number' && d.playHeight > 0 ? d.playHeight : null,
    bodyHair: oneOf(PLAY_BODY_HAIR_LABELS, d.playBodyHair),
    grooming: oneOf(PLAY_GROOMING_LABELS, d.playGrooming),
    energy: oneOf(PLAY_ENERGY_LABELS, d.playEnergy),
    typePreferences: parseTypePreferences(d.typePreferences),
    goDeeper,
  }
}
