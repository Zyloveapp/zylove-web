import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import PhotosStep from '../components/onboarding/PhotosStep'
import { MAX_PHOTOS, releasePhotoPreview } from '../components/onboarding/types'
import { selectPlayPrompts } from '../types/dualProfile'
import { PLAY_BODY_TYPE_LABELS, type PlayBodyType } from '../types/playDescriptors'
import {
  MIN_PLAY_ANSWERS,
  emptyPlayDraft,
  generatePlayBio,
  loadPlayDraft,
  playAnswerCount,
  savePlayOnboarding,
  tagsIn,
  type PlayDraft,
} from '../services/playOnboarding'
import {
  AboutYouStep,
  ArrangementStep,
  MyTypeStep,
  NonNegotiablesStep,
  PLAY_BIO_MAX,
  PlayBioStep,
  PlayPromptsStep,
  PlayReviewStep,
  PlayWelcomeStep,
  SceneStep,
  SpiceStep,
} from '../components/onboarding/PlaySteps'

const RED = '#E03131'

// The bio comes after the prompts (as on mobile) so generation has something
// to work from.
const STEPS = [
  'welcome',
  'photos',
  'spice',
  'aboutYou',
  'arrangement',
  'scene',
  'nonNegotiables',
  'myType',
  'prompts',
  'bio',
  'review',
] as const
type StepId = (typeof STEPS)[number]

const OPTIONAL_STEPS: StepId[] = ['aboutYou', 'scene', 'nonNegotiables', 'myType']

const primaryButton =
  'w-full rounded-xl bg-[#E03131] py-3 font-semibold text-white transition-colors hover:bg-[#E03131]/90 disabled:opacity-40'

function isBodyType(v: unknown): v is PlayBodyType {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PLAY_BODY_TYPE_LABELS, v)
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PlayOnboarding() {
  const navigate = useNavigate()
  const setMode = useModeStore((s) => s.setMode)
  // AuthGuard guarantees a signed-in user on this route.
  const uid = useAuthStore((s) => s.user?.uid) ?? ''

  // ?edit=true (Me → "Edit Play profile"): prefill from the saved Play
  // profile and start at photos. Without a saved profile it's a normal setup.
  const [searchParams] = useSearchParams()
  const wantsEdit = searchParams.get('edit') === 'true'
  const [edit, setEdit] = useState<'loading' | 'ready' | 'none'>(wantsEdit ? 'loading' : 'none')
  const editing = edit === 'ready'

  const [stepIndex, setStepIndex] = useState(0)
  const [draft, setDraft] = useState<PlayDraft>(() => emptyPlayDraft(uid))
  const [bioEditing, setBioEditing] = useState(false)
  const [bioBusy, setBioBusy] = useState(false)
  const [bioMessage, setBioMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Set after a successful first save when some photos didn't publish yet.
  const [photoNotices, setPhotoNotices] = useState<string[] | null>(null)
  // Gender and attraction for the bio prompt come from the shared root profile.
  const [identity, setIdentity] = useState<{ genderIdentity: unknown; attractedTo: unknown }>({
    genderIdentity: null,
    attractedTo: null,
  })

  const update = (patch: Partial<PlayDraft>) => setDraft((d) => ({ ...d, ...patch }))

  useEffect(() => {
    if (!wantsEdit || !uid) return
    let cancelled = false
    loadPlayDraft(uid, selectPlayPrompts(uid).map((p) => p.id))
      .catch(() => null)
      .then((saved) => {
        if (cancelled) return
        if (!saved) return setEdit('none')
        setDraft(saved)
        setBioEditing(saved.bio.trim() !== '')
        setStepIndex(STEPS.indexOf('photos'))
        setEdit('ready')
      })
    return () => {
      cancelled = true
    }
  }, [wantsEdit, uid])

  // Identity for the bio prompt; on a first setup, height and body type are
  // pre-filled from the Spark profile (still editable on "About you").
  useEffect(() => {
    if (!uid) return
    getDoc(doc(db, 'users', uid))
      .then((snap) => {
        const data = snap.data()
        setIdentity({ genderIdentity: data?.genderIdentity, attractedTo: data?.attractedTo })
        if (wantsEdit) return
        const heightCm: unknown = data?.heightCm
        const bodyType: unknown = data?.bodyType
        setDraft((d) => ({
          ...d,
          heightCm: d.heightCm ?? (typeof heightCm === 'number' && heightCm > 0 ? heightCm : null),
          bodyType: d.bodyType ?? (isBodyType(bodyType) ? bodyType : null),
        }))
      })
      .catch(() => {})
  }, [uid, wantsEdit])

  // Release photo preview object URLs when leaving the page.
  const photosRef = useRef(draft.photos)
  useEffect(() => {
    photosRef.current = draft.photos
  }, [draft.photos])
  useEffect(() => () => photosRef.current.forEach(releasePhotoPreview), [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [stepIndex])

  const step: StepId = STEPS[stepIndex]

  function canAdvance(id: StepId): boolean {
    switch (id) {
      case 'photos':
        return draft.photos.length >= 1 && draft.photos.length <= MAX_PHOTOS
      case 'spice':
        return draft.spiceLevel !== null
      case 'arrangement':
        return tagsIn(draft.tags, 'arrangement').length > 0
      case 'prompts':
        return playAnswerCount(draft) >= MIN_PLAY_ANSWERS
      case 'bio':
        return draft.bio.trim().length > 0 && !bioBusy
      default:
        return true
    }
  }

  async function handleGenerate() {
    setBioBusy(true)
    setBioMessage(null)
    setBioEditing(true)
    const result = await generatePlayBio(draft, identity)
    if ('bio' in result) update({ bio: result.bio.slice(0, PLAY_BIO_MAX) })
    else
      setBioMessage(
        result.error === 'limit'
          ? "You've used this week's 3 bio generations — write it yourself for now."
          : "Couldn't generate a bio right now. Try again or write it yourself.",
      )
    setBioBusy(false)
  }

  // Not straight into Play: Header sees the param and runs the normal entry
  // (PIN setup, then the "Play time." transition).
  function continueToPlay() {
    setMode('spark')
    navigate('/discover?play_setup_complete=true', { replace: true })
  }

  async function enterPlay() {
    setSaving(true)
    setSaveError(null)
    try {
      if (editing) {
        const notices = await savePlayOnboarding(uid, draft, { keepIntent: true })
        const flash = notices.length > 0 ? notices.join(' ') : '✦ Play profile updated.'
        navigate('/profile', { replace: true, state: { flash } })
        return
      }
      const notices = await savePlayOnboarding(uid, draft)
      // Saved; a photo still under review is explained before moving on.
      if (notices.length > 0) {
        setPhotoNotices(notices)
        setSaving(false)
        return
      }
      continueToPlay()
    } catch {
      setSaveError("Couldn't save your Play profile. Check your connection and try again.")
      setSaving(false)
    }
  }

  function renderStep() {
    const props = { play: draft, update }
    switch (step) {
      case 'welcome':
        return <PlayWelcomeStep />
      case 'photos':
        return (
          <PhotosStep
            variant="play"
            title="Your Play photos"
            subtitle={`Up to ${MAX_PHOTOS} photos · Not shared with Spark.`}
            photos={draft.photos}
            onChange={(photos) => update({ photos })}
          />
        )
      case 'spice':
        return <SpiceStep {...props} />
      case 'aboutYou':
        return <AboutYouStep {...props} />
      case 'arrangement':
        return <ArrangementStep {...props} />
      case 'scene':
        return <SceneStep {...props} />
      case 'nonNegotiables':
        return <NonNegotiablesStep {...props} />
      case 'myType':
        return <MyTypeStep {...props} />
      case 'prompts':
        return <PlayPromptsStep {...props} />
      case 'bio':
        return (
          <PlayBioStep
            bio={draft.bio}
            editing={bioEditing}
            busy={bioBusy}
            message={bioMessage}
            onChange={(bio) => update({ bio })}
            onGenerate={handleGenerate}
            onWrite={() => setBioEditing(true)}
          />
        )
      case 'review':
        return (
          <PlayReviewStep
            play={draft}
            photoUrl={draft.photos[0]?.previewUrl ?? null}
            error={saveError}
            notices={photoNotices}
          />
        )
    }
  }

  // Editing skips the welcome step, so photos is where "Cancel" lives.
  const isFirst = stepIndex === (editing ? STEPS.indexOf('photos') : 0)
  const isLast = step === 'review'

  if (edit === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-[#E03131]" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="mx-auto w-full max-w-md px-4 pb-32 pt-6">
        {editing && (
          <p className="mb-5 rounded-xl border border-[#E03131]/30 bg-[#E03131]/10 px-4 py-3 text-center text-sm text-red-200">
            Updating your Play profile — your answers are pre-filled.
          </p>
        )}
        <div className="mb-8">
          <div className="h-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%`, backgroundColor: RED }}
            />
          </div>
          <div className="mt-3 flex justify-center gap-1.5" aria-label={`Step ${stepIndex + 1} of ${STEPS.length}`}>
            {STEPS.map((s, i) => (
              <span
                key={s}
                className={`h-1.5 w-1.5 rounded-full ${i <= stepIndex ? 'bg-[#E03131]' : 'bg-white/15'}`}
                aria-hidden
              />
            ))}
          </div>
        </div>

        <main>{renderStep()}</main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 border-t border-white/10 bg-gray-950/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur">
        <div className="mx-auto flex w-full max-w-md gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => (isFirst ? navigate(-1) : setStepIndex((i) => i - 1))}
            disabled={saving || photoNotices !== null}
            className="rounded-xl border border-white/15 px-5 py-3 font-medium text-white/70 hover:bg-white/5 disabled:opacity-40"
          >
            {isFirst ? 'Cancel' : 'Back'}
          </button>
          {isLast && photoNotices ? (
            <button type="button" onClick={continueToPlay} className={primaryButton}>
              Continue to Play →
            </button>
          ) : isLast ? (
            <button type="button" onClick={enterPlay} disabled={saving} className={primaryButton}>
              {saving ? 'Saving…' : editing ? 'Save changes ✦' : "🔥 Let's Play"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStepIndex((i) => i + 1)}
              disabled={!canAdvance(step)}
              className={primaryButton}
            >
              {isFirst ? "Let's go →" : OPTIONAL_STEPS.includes(step) ? 'Next (optional) →' : 'Next →'}
            </button>
          )}
        </div>
      </nav>
    </div>
  )
}
