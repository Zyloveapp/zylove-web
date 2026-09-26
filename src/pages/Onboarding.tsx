import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { FirebaseError } from 'firebase/app'
import type { DatingIntent } from '../types/profile'
import { useAuthStore } from '../store/authStore'
import { saveSparkOnboarding } from '../services/onboarding'
import StepIndicator from '../components/onboarding/StepIndicator'
import IntentStep from '../components/onboarding/IntentStep'
import BasicInfoStep from '../components/onboarding/BasicInfoStep'
import PhotosStep from '../components/onboarding/PhotosStep'
import PromptsStep from '../components/onboarding/PromptsStep'
import SeekingStep from '../components/onboarding/SeekingStep'
import DoneStep from '../components/onboarding/DoneStep'
import {
  MAX_PHOTOS,
  PROMPT_COUNT,
  parseAge,
  type IntentChoice,
  type OnboardingDraft,
} from '../components/onboarding/types'

const STEPS = ['Intent', 'Basics', 'Photos', 'Prompts', 'Seeking', 'Done'] as const
const LAST = STEPS.length - 1

// "Both" has no dedicated DatingIntent; 'open' is the mobile app's either-mode value.
const INTENT_TO_DATING_INTENT: Record<IntentChoice, DatingIntent> = {
  spark: 'spark',
  play: 'play',
  both: 'open',
}

const EMPTY_DRAFT: OnboardingDraft = {
  intent: null,
  displayName: '',
  age: '',
  genderIdentity: null,
  genderSelfDescribe: '',
  attractedTo: [],
  photos: [],
  prompts: [],
  seeking: {
    heightPreference: 'no_preference',
    bodyTypePreference: [],
    seekingTraits: [],
    topValues: [],
    dealbreakers: [],
  },
}

function isStepValid(step: number, d: OnboardingDraft): boolean {
  switch (step) {
    case 0:
      return d.intent !== null
    case 1:
      return (
        d.displayName.trim().length > 0 &&
        parseAge(d.age) !== null &&
        d.genderIdentity !== null &&
        (d.genderIdentity !== 'self_describe' || d.genderSelfDescribe.trim().length > 0) &&
        d.attractedTo.length > 0
      )
    case 2:
      return d.photos.length >= 1 && d.photos.length <= MAX_PHOTOS
    case 3:
      return d.prompts.length === PROMPT_COUNT && d.prompts.every((p) => p.answer.trim().length > 0)
    case 4:
      return d.seeking.seekingTraits.length > 0
    default:
      return true
  }
}

function saveErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    if (err.code === 'permission-denied' || err.code === 'storage/unauthorized') {
      return "You don't have permission to save this profile. Try signing in again."
    }
    return `Couldn't save your profile (${err.code}). Try again.`
  }
  return "Couldn't save your profile. Check your connection and try again."
}

export default function Onboarding() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const authLoading = useAuthStore((s) => s.loading)

  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Release photo preview object URLs when leaving the page.
  const photosRef = useRef(draft.photos)
  useEffect(() => {
    photosRef.current = draft.photos
  }, [draft.photos])
  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl)), [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [step])

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-gray-800" />
      </div>
    )
  }
  // Saving needs a uid for Storage + Firestore paths.
  if (!user) return <Navigate to="/login" replace />

  const update = (patch: Partial<OnboardingDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const canAdvance = isStepValid(step, draft)

  async function handleSave() {
    if (!user) return
    const age = parseAge(draft.age)
    if (!draft.intent || !draft.genderIdentity || age === null) return

    setSaving(true)
    setSaveError(null)
    try {
      await saveSparkOnboarding(user.uid, {
        intent: INTENT_TO_DATING_INTENT[draft.intent],
        displayName: draft.displayName,
        age,
        genderIdentity: draft.genderIdentity,
        genderSelfDescribe: draft.genderSelfDescribe,
        attractedTo: draft.attractedTo,
        photos: draft.photos.map((p) => p.file),
        promptAnswers: draft.prompts.map((p) => ({ promptId: p.promptId, answer: p.answer.trim() })),
        seeking: {
          heightPreference: draft.seeking.heightPreference,
          bodyTypePreference: draft.seeking.bodyTypePreference,
          personalityPriorities: draft.seeking.seekingTraits,
          topValues: draft.seeking.topValues,
          dealbreakers: draft.seeking.dealbreakers,
        },
      })
      setSaved(true)
    } catch (err) {
      setSaveError(saveErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-28 pt-6">
        <StepIndicator steps={STEPS} current={step} />

        <main className="mt-6 flex-1">
          {step === 0 && <IntentStep intent={draft.intent} onChange={(intent) => update({ intent })} />}
          {step === 1 && <BasicInfoStep value={draft} onChange={update} />}
          {step === 2 && <PhotosStep photos={draft.photos} onChange={(photos) => update({ photos })} />}
          {step === 3 && <PromptsStep prompts={draft.prompts} onChange={(prompts) => update({ prompts })} />}
          {step === 4 && (
            <SeekingStep
              value={draft.seeking}
              onChange={(patch) => setDraft((d) => ({ ...d, seeking: { ...d.seeking, ...patch } }))}
            />
          )}
          {step === LAST && (
            <DoneStep
              draft={draft}
              saving={saving}
              saved={saved}
              error={saveError}
              onSave={handleSave}
              onContinue={() => navigate('/discover', { replace: true })}
            />
          )}
        </main>
      </div>

      {!saved && (
        <nav className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-md gap-3 px-4 py-3">
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              disabled={step === 0 || saving}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-medium text-gray-700 disabled:opacity-40"
            >
              Back
            </button>
            {step < LAST && (
              <button
                type="button"
                onClick={() => setStep((s) => s + 1)}
                disabled={!canAdvance}
                className="flex-1 rounded-lg bg-gray-900 px-4 py-3 font-medium text-white disabled:opacity-40"
              >
                Next
              </button>
            )}
          </div>
        </nav>
      )}
    </div>
  )
}
