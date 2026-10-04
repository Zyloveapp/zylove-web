import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { FirebaseError } from 'firebase/app'
import { doc, getDoc } from 'firebase/firestore'
import { useAuthStore } from '../store/authStore'
import { db } from '../services/firebase'
import { useModeStore } from '../store/modeStore'
import { OFF_MAP_GENDER_IDENTITIES } from '../types/profile'
import { loadRefreshDraft, recordLegalAcceptance, saveSparkOnboarding } from '../services/onboarding'
import type { PromptAnswer } from '../types/dualProfile'
import {
  MIN_PLAY_ANSWERS,
  emptyPlayDraft,
  generatePlayBio,
  needsPlayTrialWelcome,
  playAnswerCount,
  savePlayOnlyOnboarding,
  tagsIn,
  type PlayDraft,
} from '../services/playOnboarding'
import { generateSparkBio } from '../services/bio'
import { claimFounderBadge } from '../services/founders'
import FounderCelebration from '../components/FounderCelebration'
import TermsStep from '../components/onboarding/TermsStep'
import NameStep from '../components/onboarding/NameStep'
import PhotosStep from '../components/onboarding/PhotosStep'
import PromptsStep from '../components/onboarding/PromptsStep'
import BioStep from '../components/onboarding/BioStep'
import ReviewStep from '../components/onboarding/ReviewStep'
import {
  AttractedToStep,
  BeliefsStep,
  BodyTypeStep,
  GenderStep,
  HabitsStep,
  HeightStep,
  KidsStep,
  LifestyleStep,
  LoveGiveStep,
  LoveReceiveStep,
  PersonalityStep,
  RelationshipStep,
  ValuesStep,
  WeekendStep,
} from '../components/onboarding/AboutSteps'
import { DiscoveryStep, NeedsStep, PhysicalPrefsStep } from '../components/onboarding/SeekingSteps'
import SparkGoDeeperSection from '../components/onboarding/SparkGoDeeperSection'
import { IntentionStep, RecommendationScreen, intentForPath } from '../components/onboarding/IntentionSteps'
import { GoDeeperIntro, GoDeeperQuestion } from '../components/onboarding/GoDeeperSteps'
import {
  AboutYouStep,
  ArrangementStep,
  MyTypeStep,
  NonNegotiablesStep,
  PLAY_BIO_MAX,
  PlayBioStep,
  PlayNameStep,
  PlayPromptsStep,
  PlayReviewStep,
  PlayTrialWelcome,
  SceneStep,
  SpiceStep,
} from '../components/onboarding/PlaySteps'
import {
  CONFLICT_STYLE_LABELS,
  INITIAL_DRAFT,
  MAX_PHOTOS,
  MAX_REFRESH_PHOTOS,
  MIN_AGE,
  PROMPT_COUNT,
  STRESS_RESPONSE_LABELS,
  TOGETHERNESS_STYLE_LABELS,
  REQUIRED_PROMPT_ANSWERS,
  totalPromptAnswers,
  heightToInches,
  parseBirthday,
  releasePhotoPreview,
  type OnboardingDraft,
  type OnboardingPath,
} from '../components/onboarding/types'

// Founder badge check after the final save, and how long the celebration shows.
const FOUNDER_CHECK_MS = 12_000
const FOUNDER_CELEBRATION_MS = 1500

const COBALT = '#1B4FD8'
const RED = '#E03131'

const STEPS = [
  { id: 'terms', title: 'Terms' },
  { id: 'name', title: 'Name' },
  { id: 'photos', title: 'Photos' },
  { id: 'gender', title: 'Gender' },
  { id: 'intention', title: 'What you want' },
  { id: 'recommendation', title: 'Your path' },
  { id: 'attractedTo', title: 'Attraction' },
  { id: 'relationship', title: 'Status' },
  { id: 'bodyType', title: 'Body type' },
  { id: 'height', title: 'Height' },
  { id: 'lifestyle', title: 'Lifestyle' },
  { id: 'habits', title: 'Habits' },
  { id: 'personality', title: 'Personality' },
  { id: 'values', title: 'Values' },
  { id: 'weekend', title: 'Weekend' },
  { id: 'loveGive', title: 'Showing love' },
  { id: 'loveReceive', title: 'Receiving love' },
  { id: 'beliefs', title: 'Beliefs' },
  { id: 'kids', title: 'Kids' },
  { id: 'physicalPrefs', title: 'Physical preferences' },
  { id: 'needs', title: 'What you need' },
  { id: 'discovery', title: 'Who you see' },
  { id: 'prompts', title: 'Prompts' },
  { id: 'goDeeper', title: 'Go Deeper' },
  { id: 'conflict', title: 'Conflict style' },
  { id: 'togetherness', title: 'Togetherness' },
  { id: 'stress', title: 'Stress response' },
  { id: 'bio', title: 'Bio' },
  { id: 'review', title: 'Review' },
] as const

// Play-only path: the shared first six steps, attraction and discovery, then
// the Play profile itself. No Spark profile is built.
const PLAY_STEPS = [
  { id: 'terms', title: 'Terms' },
  { id: 'name', title: 'Name' },
  { id: 'photos', title: 'Photos' },
  { id: 'gender', title: 'Gender' },
  { id: 'intention', title: 'What you want' },
  { id: 'recommendation', title: 'Your path' },
  { id: 'attractedTo', title: 'Attraction' },
  { id: 'discovery', title: 'Who you see' },
  { id: 'playName', title: 'Play name' },
  { id: 'spice', title: 'Spice level' },
  { id: 'aboutYou', title: 'About you' },
  { id: 'arrangement', title: 'Looking for' },
  { id: 'scene', title: 'Your scene' },
  { id: 'nonNegotiables', title: 'Non-negotiables' },
  { id: 'myType', title: 'My type' },
  { id: 'playPrompts', title: 'Prompts' },
  { id: 'playBio', title: 'Bio' },
  { id: 'playReview', title: 'Review' },
] as const

// A Play-only user building their Spark profile (?spark=setup, from the mode
// pill): a Spark welcome, then the full Spark flow without terms (accepted)
// or the intention steps (they already chose Spark).
const SPARK_SETUP_STEPS = [
  { id: 'sparkWelcome', title: 'Welcome' },
  ...STEPS.filter((s) => s.id !== 'terms' && s.id !== 'intention' && s.id !== 'recommendation'),
] as const

type StepId =
  | (typeof STEPS)[number]['id']
  | (typeof PLAY_STEPS)[number]['id']
  | (typeof SPARK_SETUP_STEPS)[number]['id']
type Step = { id: StepId; title: string }

// Spark, Both and Unsure build the full Spark profile; Play builds only the
// Play profile. A refresh (always Spark) skips terms (already accepted), the
// intention steps (first run only) and, once identity is locked, gender.
function stepsFor(refresh: boolean, identityLocked: boolean, path: OnboardingPath | null): readonly Step[] {
  const base: readonly Step[] = !refresh && path === 'play' ? PLAY_STEPS : STEPS
  return base.filter(
    (s) =>
      !(refresh && (s.id === 'terms' || s.id === 'intention' || s.id === 'recommendation')) &&
      !(identityLocked && s.id === 'gender'),
  )
}

function isStepValid(
  id: StepId,
  d: OnboardingDraft,
  bioGenerating: boolean,
  identityLocked: boolean,
  maxPhotos: number,
  play: PlayDraft,
  playBioBusy: boolean,
): boolean {
  switch (id) {
    case 'terms':
      return d.termsAccepted
    case 'name': {
      if (identityLocked) return d.displayName.trim().length > 0
      const b = parseBirthday(d.birthdayRaw)
      return d.legalName.trim().length > 0 && d.displayName.trim().length > 0 && b !== null && b.age >= MIN_AGE
    }
    case 'photos':
      return d.photos.length >= 1 && d.photos.length <= maxPhotos
    case 'gender':
      return (
        d.genderIdentity !== null &&
        (d.genderIdentity !== 'self_describe' || d.genderSelfDescribe.trim() !== '') &&
        (!OFF_MAP_GENDER_IDENTITIES.includes(d.genderIdentity) || d.matchableAs.length > 0)
      )
    case 'intention':
      return d.intentionAnswers.length > 0 && d.onboardingPath !== null
    case 'attractedTo':
      return d.attractedTo.length > 0
    case 'relationship':
      return d.relationshipStatus !== null && d.openTo.length > 0
    case 'lifestyle':
      return d.lifestyleTags.length > 0
    case 'personality':
      return d.personalityTraits.length > 0
    case 'values':
      return d.relationshipValues.length > 0
    case 'weekend':
      return d.weekendVibes.length > 0
    case 'loveGive':
      return d.loveLangGive.length > 0
    case 'loveReceive':
      return d.loveLangReceive.length > 0
    case 'physicalPrefs':
      return d.seekingHeightNoPreference || heightToInches(d.seekingHeightMin) <= heightToInches(d.seekingHeightMax)
    case 'discovery':
      return d.ageMin < d.ageMax
    case 'prompts':
      // Any mix of the standard prompts and Go Deeper.
      return d.selectedPromptIds.length === PROMPT_COUNT && totalPromptAnswers(d) >= REQUIRED_PROMPT_ANSWERS
    case 'conflict':
      return d.conflictStyle !== null
    case 'togetherness':
      return d.togethernessStyle !== null
    case 'stress':
      return d.stressResponse !== null
    case 'bio':
      return !bioGenerating
    case 'playName':
      return play.playDisplayName.trim().length > 0
    case 'spice':
      return play.spiceLevel !== null
    case 'arrangement':
      return tagsIn(play.tags, 'arrangement').length > 0
    case 'playPrompts':
      return playAnswerCount(play) >= MIN_PLAY_ANSWERS
    case 'playBio':
      return play.bio.trim().length > 0 && !playBioBusy
    default:
      return true
  }
}

function saveErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    if (err.code === 'storage/unauthorized') {
      return "Couldn't upload your photos — the server rejected them (storage/unauthorized)."
    }
    if (err.code === 'permission-denied') {
      return "Couldn't save your profile — the server rejected the write (permission-denied)."
    }
    return `Couldn't save your profile (${err.code}). Try again.`
  }
  return "Couldn't save your profile. Check your connection and try again."
}

export default function Onboarding() {
  const navigate = useNavigate()
  const setMode = useModeStore((s) => s.setMode)
  const user = useAuthStore((s) => s.user)
  const authLoading = useAuthStore((s) => s.loading)
  const [searchParams] = useSearchParams()
  // "Reimagine my profile": same flow, pre-filled from the saved profile.
  const refresh = searchParams.get('refresh') === 'true'
  const sparkSetup = !refresh && searchParams.get('spark') === 'setup'
  const [setupLoad, setSetupLoad] = useState<{ uid: string; locked: boolean } | 'error' | null>(null)
  const [refreshLoad, setRefreshLoad] = useState<
    { uid: string; locked: boolean; extraPrompts: PromptAnswer[] } | 'error' | null
  >(null)

  const [stepIndex, setStepIndex] = useState(0)
  const [draft, setDraft] = useState<OnboardingDraft>(INITIAL_DRAFT)
  const [bioGenerating, setBioGenerating] = useState(false)
  const [bioUsedFallback, setBioUsedFallback] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [founder, setFounder] = useState<{ number: number; cityName?: string } | null>(null)
  // Incremented to discard an in-flight bio request (skip or regenerate).
  const bioRequest = useRef(0)
  // Play-only path: the Play profile answers (photos live on draft.photos).
  const [play, setPlay] = useState<PlayDraft>(() => emptyPlayDraft(user?.uid ?? ''))
  const [playBioEditing, setPlayBioEditing] = useState(false)
  const [playBioBusy, setPlayBioBusy] = useState(false)
  const [playBioMessage, setPlayBioMessage] = useState<string | null>(null)
  // Set after a successful Play save when some photos didn't publish yet.
  const [playNotices, setPlayNotices] = useState<string[] | null>(null)
  // After the Play save: whether the trial welcome is due, and whether it's showing.
  const [trialWelcomeDue, setTrialWelcomeDue] = useState(false)
  const [trialWelcomeOpen, setTrialWelcomeOpen] = useState(false)

  // Release photo preview object URLs when leaving the page.
  const photosRef = useRef(draft.photos)
  useEffect(() => {
    photosRef.current = draft.photos
  }, [draft.photos])
  useEffect(() => () => photosRef.current.forEach(releasePhotoPreview), [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [stepIndex])

  const userId = user?.uid
  useEffect(() => {
    if (!refresh || !userId) return
    let cancelled = false
    loadRefreshDraft(userId)
      .then((loaded) => {
        if (cancelled) return
        if (!loaded) return setRefreshLoad('error')
        setDraft(loaded.draft)
        setRefreshLoad({ uid: userId, locked: loaded.identityLocked, extraPrompts: loaded.extraPrompts })
      })
      .catch(() => !cancelled && setRefreshLoad('error'))
    return () => {
      cancelled = true
    }
  }, [refresh, userId])

  // Spark setup: identity and who-you-see carry over from the account; every
  // Spark answer — photos included — starts fresh, so Play photos never end
  // up on the Spark profile.
  useEffect(() => {
    if (!sparkSetup || !userId) return
    let cancelled = false
    Promise.all([loadRefreshDraft(userId), getDoc(doc(db, 'users', userId))])
      .then(([loaded, root]) => {
        if (cancelled) return
        if (!loaded) return setSetupLoad('error')
        const d = loaded.draft
        const answers: unknown = root.data()?.intentionAnswers
        setDraft({
          ...INITIAL_DRAFT,
          termsAccepted: true,
          displayName: d.displayName,
          birthdayRaw: d.birthdayRaw,
          genderIdentity: d.genderIdentity,
          genderSelfDescribe: d.genderSelfDescribe,
          matchableAs: d.matchableAs,
          pronouns: d.pronouns,
          attractedTo: d.attractedTo,
          radiusMiles: d.radiusMiles,
          ageMin: d.ageMin,
          ageMax: d.ageMax,
          intent: 'open',
          onboardingPath: 'both',
          intentionAnswers: Array.isArray(answers) ? answers.filter((a): a is string => typeof a === 'string') : [],
        })
        setSetupLoad({ uid: userId, locked: loaded.identityLocked })
      })
      .catch(() => !cancelled && setSetupLoad('error'))
    return () => {
      cancelled = true
    }
  }, [sparkSetup, userId])

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/15 border-t-white" />
      </div>
    )
  }
  // Legal acceptance, Storage and Firestore paths all need a uid.
  if (!user) return <Navigate to="/login" replace />
  const uid = user.uid

  if (refresh && refreshLoad === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-950 px-4 text-center">
        <p className="text-white/80">We couldn't load your profile to refresh it.</p>
        <button type="button" onClick={() => navigate('/profile/edit')} className="text-sm text-white/50 underline">
          Back to Edit Profile
        </button>
      </div>
    )
  }
  // Wait for the pre-fill so nothing is edited (or saved) over an empty draft.
  if (refresh && (refreshLoad === null || refreshLoad === 'error' || refreshLoad.uid !== uid)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/15 border-t-white" />
      </div>
    )
  }

  if (sparkSetup && setupLoad === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-950 px-4 text-center">
        <p className="text-white/80">We couldn't load your account to start your Spark profile.</p>
        <button type="button" onClick={() => navigate('/discover')} className="text-sm text-white/50 underline">
          Back
        </button>
      </div>
    )
  }
  if (sparkSetup && (setupLoad === null || setupLoad === 'error' || setupLoad.uid !== uid)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/15 border-t-white" />
      </div>
    )
  }

  const refreshInfo = refresh && typeof refreshLoad === 'object' ? refreshLoad : null
  const setupInfo = sparkSetup && typeof setupLoad === 'object' ? setupLoad : null
  const identityLocked = refreshInfo?.locked ?? setupInfo?.locked ?? false
  const maxPhotos = refresh ? MAX_REFRESH_PHOTOS : MAX_PHOTOS
  const steps: readonly Step[] = sparkSetup
    ? SPARK_SETUP_STEPS.filter((s) => !(identityLocked && s.id === 'gender'))
    : stepsFor(refresh, identityLocked, draft.onboardingPath)
  const step = steps[stepIndex]
  const update = (patch: Partial<OnboardingDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const updatePlay = (patch: Partial<PlayDraft>) => setPlay((p) => ({ ...p, ...patch }))
  // Play-only path turns red once the Play recommendation has been accepted.
  const playPath = !refresh && draft.onboardingPath === 'play'
  const red = playPath && stepIndex > steps.findIndex((s) => s.id === 'recommendation')
  const accent = red ? RED : COBALT

  function startBio() {
    const id = ++bioRequest.current
    setBioGenerating(true)
    generateSparkBio(draft).then((result) => {
      if (bioRequest.current !== id) return
      setDraft((d) => ({ ...d, bio: result.bio, bioGeneratedAt: result.generated ? Date.now() : null }))
      setBioUsedFallback(!result.generated)
      setBioGenerating(false)
    })
  }

  function goTo(id: StepId) {
    if (id === 'bio' && !draft.bio.trim() && !bioGenerating) startBio()
    setStepIndex(steps.findIndex((s) => s.id === id))
  }

  function next() {
    const following = steps[stepIndex + 1]
    if (following) goTo(following.id)
  }

  function skipBio() {
    bioRequest.current++
    setBioGenerating(false)
    update({ bio: '', bioGeneratedAt: null })
    goTo('review')
  }

  async function acceptTerms() {
    await recordLegalAcceptance(uid)
    update({ termsAccepted: true })
    next()
  }

  // City founding circle: capped so a location prompt left open can't
  // hold onboarding up; any failure just carries on.
  async function finishWithFounderCheck(finish: () => void) {
    const founder = await Promise.race([
      claimFounderBadge(uid),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FOUNDER_CHECK_MS)),
    ])
    if (founder?.eligible) {
      setFounder({ number: founder.cohortNumber, cityName: founder.cityName })
      setTimeout(finish, FOUNDER_CELEBRATION_MS)
    } else {
      finish()
    }
  }

  async function createProfile() {
    setSaving(true)
    setSaveError(null)
    try {
      const photoNotices = await saveSparkOnboarding(uid, draft, {
        extraPrompts: refreshInfo?.extraPrompts,
        newSparkProfile: sparkSetup,
      })
      // A photo still under review (or slow) goes on the profile page, where
      // the notice shows; Discover needs a published photo anyway.
      await finishWithFounderCheck(() => {
        // Both profiles now exist, so Spark is home.
        if (sparkSetup) setMode('spark')
        if (photoNotices.length > 0) navigate('/profile', { replace: true, state: { flash: photoNotices.join(' ') } })
        else if (refresh) navigate('/profile', { replace: true, state: { flash: '✦ Profile refreshed.' } })
        else navigate('/discover', { replace: true })
      })
    } catch (err) {
      setSaveError(saveErrorMessage(err))
      setSaving(false)
    }
  }

  async function generatePlayBioDraft() {
    setPlayBioBusy(true)
    setPlayBioMessage(null)
    setPlayBioEditing(true)
    // From the draft: the root profile doesn't exist yet on this path.
    const result = await generatePlayBio(play, { genderIdentity: draft.genderIdentity, attractedTo: draft.attractedTo })
    if ('bio' in result) updatePlay({ bio: result.bio.slice(0, PLAY_BIO_MAX) })
    else
      setPlayBioMessage(
        result.error === 'limit'
          ? "You've used this week's 3 bio generations — write it yourself for now."
          : "Couldn't generate a bio right now. Try again or write it yourself.",
      )
    setPlayBioBusy(false)
  }

  // Not straight into Play: Header sees the param and runs the normal entry
  // (PIN setup, then the "Play time." transition).
  function continueToPlay() {
    setMode('spark')
    navigate('/discover?play_setup_complete=true', { replace: true })
  }

  // Trial users see the welcome first; its button carries on into Play.
  function enterPlay(welcomeDue = trialWelcomeDue) {
    if (welcomeDue) setTrialWelcomeOpen(true)
    else continueToPlay()
  }

  async function launchPlay() {
    setSaving(true)
    setSaveError(null)
    try {
      const notices = await savePlayOnlyOnboarding(uid, draft, play)
      // Founder badge first: a founder never sees the trial welcome.
      await finishWithFounderCheck(async () => {
        const welcomeDue = await needsPlayTrialWelcome(uid).catch(() => false)
        setTrialWelcomeDue(welcomeDue)
        // Saved; a photo still under review is explained before moving on.
        if (notices.length > 0) {
          setPlayNotices(notices)
          setSaving(false)
        } else {
          enterPlay(welcomeDue)
        }
      })
    } catch (err) {
      setSaveError(saveErrorMessage(err))
      setSaving(false)
    }
  }

  function renderStep() {
    const props = { draft, update }
    const playProps = { play, update: updatePlay }
    switch (step.id) {
      case 'sparkWelcome':
        return (
          <div className="flex min-h-[60dvh] flex-col justify-center text-center">
            <h1 className="text-3xl font-bold text-white">✦ Building your Spark profile</h1>
            <p className="mt-4 text-lg text-white/70">Real compatibility. Intentional connections. Something worth keeping.</p>
            <p className="mt-4 text-white/50">Your Play profile stays completely separate.</p>
            <button
              type="button"
              onClick={next}
              autoFocus
              className="mt-10 w-full rounded-xl bg-[#1B4FD8] py-4 font-semibold text-white transition-opacity hover:opacity-90"
            >
              Let's go →
            </button>
          </div>
        )
      case 'terms':
        return <TermsStep accepted={draft.termsAccepted} onAccept={acceptTerms} />
      case 'name':
        return (
          <NameStep
            legalName={draft.legalName}
            displayName={draft.displayName}
            birthdayRaw={draft.birthdayRaw}
            birthdayLocked={identityLocked}
            onChange={update}
          />
        )
      case 'photos':
        return <PhotosStep photos={draft.photos} onChange={(photos) => update({ photos })} maxPhotos={maxPhotos} />
      case 'gender':
        return <GenderStep {...props} />
      case 'intention':
        return <IntentionStep {...props} />
      case 'recommendation':
        return draft.onboardingPath ? (
          <RecommendationScreen
            path={draft.onboardingPath}
            onContinue={next}
            onChoose={(path, advance) => {
              update({ onboardingPath: path, intent: intentForPath(path) })
              // The step list depends on the path, so re-anchor by step id.
              const at = stepsFor(refresh, identityLocked, path).findIndex((s) => s.id === 'recommendation')
              setStepIndex(advance ? at + 1 : at)
            }}
            onBack={() => setStepIndex((i) => i - 1)}
          />
        ) : null
      case 'attractedTo':
        return <AttractedToStep {...props} />
      case 'relationship':
        return <RelationshipStep {...props} />
      case 'bodyType':
        return <BodyTypeStep {...props} onSkip={next} />
      case 'height':
        return <HeightStep {...props} />
      case 'lifestyle':
        return <LifestyleStep {...props} />
      case 'habits':
        return <HabitsStep {...props} />
      case 'personality':
        return <PersonalityStep {...props} />
      case 'values':
        return <ValuesStep {...props} />
      case 'weekend':
        return <WeekendStep {...props} />
      case 'loveGive':
        return <LoveGiveStep {...props} />
      case 'loveReceive':
        return <LoveReceiveStep {...props} />
      case 'beliefs':
        return <BeliefsStep {...props} onSkip={next} />
      case 'kids':
        return <KidsStep {...props} onSkip={next} />
      case 'physicalPrefs':
        return <PhysicalPrefsStep {...props} />
      case 'needs':
        return <NeedsStep {...props} />
      case 'discovery':
        return <DiscoveryStep {...props} />
      case 'prompts':
        return (
          <>
            <p className="mb-4 text-right text-xs font-semibold text-[#7C9BFF]">
              {Math.min(totalPromptAnswers(draft), REQUIRED_PROMPT_ANSWERS)} of {REQUIRED_PROMPT_ANSWERS} required
            </p>
            <PromptsStep {...props} />
            <SparkGoDeeperSection draft={draft} update={update} />
          </>
        )
      case 'goDeeper':
        return <GoDeeperIntro onStart={() => goTo('conflict')} onSkip={() => goTo('bio')} />
      case 'conflict':
        return (
          <GoDeeperQuestion
            title="When conflict comes up…"
            labels={CONFLICT_STYLE_LABELS}
            value={draft.conflictStyle}
            onChange={(conflictStyle) => update({ conflictStyle })}
            onSkip={() => {
              update({ conflictStyle: null })
              goTo('togetherness')
            }}
          />
        )
      case 'togetherness':
        return (
          <GoDeeperQuestion
            title="In a relationship, I need…"
            labels={TOGETHERNESS_STYLE_LABELS}
            value={draft.togethernessStyle}
            onChange={(togethernessStyle) => update({ togethernessStyle })}
            onSkip={() => {
              update({ togethernessStyle: null })
              goTo('stress')
            }}
          />
        )
      case 'stress':
        return (
          <GoDeeperQuestion
            title="When I'm stressed, I…"
            labels={STRESS_RESPONSE_LABELS}
            value={draft.stressResponse}
            onChange={(stressResponse) => update({ stressResponse })}
            onSkip={() => {
              update({ stressResponse: null })
              goTo('bio')
            }}
          />
        )
      case 'bio':
        return (
          <BioStep
            bio={draft.bio}
            generating={bioGenerating}
            usedFallback={bioUsedFallback}
            onChange={(bio) => update({ bio })}
            onRegenerate={startBio}
            onSkip={skipBio}
          />
        )
      case 'review':
        return <ReviewStep draft={draft} saving={saving} error={saveError} onCreate={createProfile} />
      case 'playName':
        return <PlayNameStep {...playProps} placeholder={draft.displayName.trim() || undefined} />
      case 'spice':
        return <SpiceStep {...playProps} />
      case 'aboutYou':
        return <AboutYouStep {...playProps} />
      case 'myType':
        return <MyTypeStep {...playProps} />
      case 'arrangement':
        return <ArrangementStep {...playProps} />
      case 'scene':
        return <SceneStep {...playProps} />
      case 'nonNegotiables':
        return <NonNegotiablesStep {...playProps} />
      case 'playPrompts':
        return <PlayPromptsStep {...playProps} />
      case 'playBio':
        return (
          <PlayBioStep
            bio={play.bio}
            editing={playBioEditing}
            busy={playBioBusy}
            message={playBioMessage}
            onChange={(bio) => updatePlay({ bio })}
            onGenerate={generatePlayBioDraft}
            onWrite={() => setPlayBioEditing(true)}
          />
        )
      case 'playReview':
        return (
          <PlayReviewStep play={play} photoUrl={draft.photos[0]?.previewUrl ?? null} error={saveError} notices={playNotices} />
        )
    }
  }

  function nextLabel(id: StepId): string {
    if (id === 'intention') return 'Continue →'
    if (!playPath) return 'Next'
    if (id === 'discovery') return "Let's go 🔥"
    if (id === 'aboutYou' || id === 'scene' || id === 'nonNegotiables' || id === 'myType') return 'Next (optional) →'
    return 'Next'
  }

  // Steps that render their own primary action instead of the bottom Next.
  const ownsPrimary =
    (step.id === 'terms' && !draft.termsAccepted) ||
    step.id === 'goDeeper' ||
    step.id === 'review' ||
    step.id === 'playReview' ||
    step.id === 'recommendation' ||
    step.id === 'sparkWelcome'
  const canAdvance = isStepValid(step.id, draft, bioGenerating, identityLocked, maxPhotos, play, playBioBusy)

  return (
    <div className="min-h-screen bg-gray-950 text-white [color-scheme:dark]" style={{ '--zy-accent': accent } as CSSProperties}>
      <div className={`mx-auto w-full max-w-md px-4 pt-6 ${step.id === 'playReview' ? 'pb-36' : 'pb-28'}`}>
        {refresh && (
          <p className="mb-5 rounded-lg bg-white/10 px-4 py-3 text-sm text-white/80">
            Refreshing your profile — your existing answers are pre-filled. Update anything that's changed.
          </p>
        )}
        <div className="mb-6">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${((stepIndex + 1) / steps.length) * 100}%`, backgroundColor: accent }}
            />
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-white/50">
            Step {stepIndex + 1} of {steps.length} · {step.title}
          </p>
        </div>

        <main>{renderStep()}</main>
      </div>

      <nav
        className={`fixed inset-x-0 bottom-0 border-t bg-gray-950/95 backdrop-blur ${
          red ? 'border-[#E03131]/20' : 'border-white/10'
        }`}
      >
        <div className="mx-auto flex w-full max-w-md gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => setStepIndex((i) => i - 1)}
            disabled={stepIndex === 0 || saving || playNotices !== null}
            className={`flex-1 rounded-lg border px-4 py-3 font-medium text-white/80 disabled:opacity-40 ${
              red ? 'border-[#E03131]/30' : 'border-white/15'
            }`}
          >
            Back
          </button>
          {step.id === 'playReview' && (
            <button
              type="button"
              onClick={playNotices ? () => enterPlay() : launchPlay}
              disabled={saving}
              className="flex-[2] rounded-lg px-4 py-3 font-semibold text-white disabled:opacity-40"
              style={{ backgroundColor: RED }}
            >
              {playNotices ? 'Continue to Play →' : saving ? 'Saving…' : "🔥 Let's Play"}
            </button>
          )}
          {!ownsPrimary && (
            <button
              type="button"
              onClick={next}
              disabled={!canAdvance}
              className="flex-1 rounded-lg px-4 py-3 font-medium text-white disabled:opacity-40"
              style={{ backgroundColor: accent }}
            >
              {nextLabel(step.id)}
            </button>
          )}
        </div>
        {step.id === 'playReview' && (
          <p className="mx-auto max-w-md px-4 pb-3 text-center text-xs text-white/40">
            You can always build a Spark profile later — tap the mode pill anytime.
          </p>
        )}
      </nav>

      {founder && <FounderCelebration number={founder.number} cityName={founder.cityName} />}
      {trialWelcomeOpen && <PlayTrialWelcome onContinue={continueToPlay} />}
    </div>
  )
}
