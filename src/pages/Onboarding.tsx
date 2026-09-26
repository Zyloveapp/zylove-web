import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { FirebaseError } from 'firebase/app'
import { useAuthStore } from '../store/authStore'
import { recordLegalAcceptance, saveSparkOnboarding } from '../services/onboarding'
import { generateSparkBio } from '../services/bio'
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
import { DiscoveryStep, IntentStep, NeedsStep, PhysicalPrefsStep } from '../components/onboarding/SeekingSteps'
import { GoDeeperIntro, GoDeeperQuestion } from '../components/onboarding/GoDeeperSteps'
import {
  CONFLICT_STYLE_LABELS,
  INITIAL_DRAFT,
  MAX_PHOTOS,
  MIN_AGE,
  MIN_PROMPT_ANSWERS,
  PROMPT_COUNT,
  STRESS_RESPONSE_LABELS,
  TOGETHERNESS_STYLE_LABELS,
  answeredPromptCount,
  heightToInches,
  parseBirthday,
  type OnboardingDraft,
} from '../components/onboarding/types'

const STEPS = [
  { id: 'terms', title: 'Terms' },
  { id: 'name', title: 'Name' },
  { id: 'photos', title: 'Photos' },
  { id: 'gender', title: 'Gender' },
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
  { id: 'intent', title: 'Intent' },
  { id: 'discovery', title: 'Who you see' },
  { id: 'prompts', title: 'Prompts' },
  { id: 'goDeeper', title: 'Go Deeper' },
  { id: 'conflict', title: 'Conflict style' },
  { id: 'togetherness', title: 'Togetherness' },
  { id: 'stress', title: 'Stress response' },
  { id: 'bio', title: 'Bio' },
  { id: 'review', title: 'Review' },
] as const

type StepId = (typeof STEPS)[number]['id']

const STEP_INDEX = Object.fromEntries(STEPS.map((s, i) => [s.id, i])) as Record<StepId, number>

function isStepValid(id: StepId, d: OnboardingDraft, bioGenerating: boolean): boolean {
  switch (id) {
    case 'terms':
      return d.termsAccepted
    case 'name': {
      const b = parseBirthday(d.birthdayRaw)
      return d.displayName.trim().length > 0 && b !== null && b.age >= MIN_AGE
    }
    case 'photos':
      return d.photos.length >= 1 && d.photos.length <= MAX_PHOTOS
    case 'gender':
      return d.genderIdentity !== null && (d.genderIdentity !== 'self_describe' || d.genderSelfDescribe.trim() !== '')
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
    case 'intent':
      return d.intent !== null
    case 'discovery':
      return d.ageMin < d.ageMax
    case 'prompts':
      return d.selectedPromptIds.length === PROMPT_COUNT && answeredPromptCount(d) >= MIN_PROMPT_ANSWERS
    case 'conflict':
      return d.conflictStyle !== null
    case 'togetherness':
      return d.togethernessStyle !== null
    case 'stress':
      return d.stressResponse !== null
    case 'bio':
      return !bioGenerating
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
  const user = useAuthStore((s) => s.user)
  const authLoading = useAuthStore((s) => s.loading)

  const [stepIndex, setStepIndex] = useState(0)
  const [draft, setDraft] = useState<OnboardingDraft>(INITIAL_DRAFT)
  const [bioGenerating, setBioGenerating] = useState(false)
  const [bioUsedFallback, setBioUsedFallback] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Incremented to discard an in-flight bio request (skip or regenerate).
  const bioRequest = useRef(0)

  // Release photo preview object URLs when leaving the page.
  const photosRef = useRef(draft.photos)
  useEffect(() => {
    photosRef.current = draft.photos
  }, [draft.photos])
  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl)), [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [stepIndex])

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-gray-800" />
      </div>
    )
  }
  // Legal acceptance, Storage and Firestore paths all need a uid.
  if (!user) return <Navigate to="/login" replace />
  const uid = user.uid

  const step = STEPS[stepIndex]
  const update = (patch: Partial<OnboardingDraft>) => setDraft((d) => ({ ...d, ...patch }))

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
    setStepIndex(STEP_INDEX[id])
  }

  function next() {
    const following = STEPS[stepIndex + 1]
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

  async function createProfile() {
    setSaving(true)
    setSaveError(null)
    try {
      await saveSparkOnboarding(uid, draft)
      navigate('/discover', { replace: true })
    } catch (err) {
      setSaveError(saveErrorMessage(err))
      setSaving(false)
    }
  }

  function renderStep() {
    const props = { draft, update }
    switch (step.id) {
      case 'terms':
        return <TermsStep accepted={draft.termsAccepted} onAccept={acceptTerms} />
      case 'name':
        return <NameStep displayName={draft.displayName} birthdayRaw={draft.birthdayRaw} onChange={update} />
      case 'photos':
        return <PhotosStep photos={draft.photos} onChange={(photos) => update({ photos })} />
      case 'gender':
        return <GenderStep {...props} />
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
      case 'intent':
        return <IntentStep {...props} />
      case 'discovery':
        return <DiscoveryStep {...props} />
      case 'prompts':
        return <PromptsStep {...props} />
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
    }
  }

  // Steps that render their own primary action instead of the bottom Next.
  const ownsPrimary =
    (step.id === 'terms' && !draft.termsAccepted) || step.id === 'goDeeper' || step.id === 'review'
  const canAdvance = isStepValid(step.id, draft, bioGenerating)

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto w-full max-w-md px-4 pb-28 pt-6">
        <div className="mb-6">
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-200">
            <div
              className="h-full rounded-full bg-gray-900 transition-all"
              style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
            />
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-gray-500">
            Step {stepIndex + 1} of {STEPS.length} · {step.title}
          </p>
        </div>

        <main>{renderStep()}</main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-md gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => setStepIndex((i) => i - 1)}
            disabled={stepIndex === 0 || saving}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-medium text-gray-700 disabled:opacity-40"
          >
            Back
          </button>
          {!ownsPrimary && (
            <button
              type="button"
              onClick={next}
              disabled={!canAdvance}
              className="flex-1 rounded-lg bg-gray-900 px-4 py-3 font-medium text-white disabled:opacity-40"
            >
              Next
            </button>
          )}
        </div>
      </nav>
    </div>
  )
}
