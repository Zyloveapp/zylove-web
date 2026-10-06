import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import { friendlyError } from '../services/errors'
import PhotosStep from '../components/onboarding/PhotosStep'
import ExitLink from '../components/onboarding/ExitLink'
import { clearDraft, loadDraft, saveDraft, storablePhotos } from '../components/onboarding/draftStorage'
import { MAX_PHOTOS, releasePhotoPreview } from '../components/onboarding/types'
import { selectPlayPrompts } from '../types/dualProfile'
import { PLAY_BODY_TYPE_LABELS, type PlayBodyType } from '../types/playDescriptors'
import { nextNameChange } from '../services/displayNames'
import { loadMatching } from '../services/privateMatching'
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
  PlayNameStep,
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
  'playName',
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
  // What the save is doing ("Uploading photos (2 of 4)…").
  const [saveProgress, setSaveProgress] = useState<string | null>(null)
  // Set once any draft saved on this device has been restored (or there was
  // none); nothing is written back before then. Keyed by uid and flow.
  const flow = wantsEdit ? 'play-edit' : 'play'
  const [restoredKey, setRestoredKey] = useState<string | null>(null)
  // A restored draft whose new photos couldn't be kept.
  const [photoReminder, setPhotoReminder] = useState(false)
  // Saved or exited: stop writing the draft back.
  const finished = useRef(false)
  // Set after a successful first save when some photos didn't publish yet.
  const [photoNotices, setPhotoNotices] = useState<string[] | null>(null)
  // Gender and attraction for the bio prompt come from the shared root profile.
  const [identity, setIdentity] = useState<{ genderIdentity: unknown; attractedTo: unknown }>({
    genderIdentity: null,
    attractedTo: null,
  })
  // Spark display name (placeholder for the Play name) and, when editing, how
  // long a recent Play name change keeps it locked.
  const [names, setNames] = useState<{ displayName: string; playNameLockedUntil: Date | null }>({
    displayName: '',
    playNameLockedUntil: null,
  })

  const update = (patch: Partial<PlayDraft>) => setDraft((d) => ({ ...d, ...patch }))

  // Picks up a draft saved on an earlier visit (draftStorage.ts) over `base`.
  // New photos aren't stored, so they need re-adding.
  function restoreSaved(base: PlayDraft, baseStep: number) {
    const saved = loadDraft<{ draft: Partial<PlayDraft>; photosMissing: boolean }>(uid, flow)
    if (saved) {
      const d = saved.data.draft
      setDraft({ ...base, ...d, photos: storablePhotos(Array.isArray(d?.photos) ? d.photos : []) })
      setStepIndex(Math.min(Math.max(0, Math.floor(saved.stepIndex)), STEPS.length - 1))
      setPhotoReminder(saved.data.photosMissing === true)
    } else {
      setDraft(base)
      setStepIndex(baseStep)
    }
    setRestoredKey(`${uid}:${flow}`)
  }

  // First setup: restore straight away (editing restores after its load).
  useEffect(() => {
    if (!uid || wantsEdit) return
    restoreSaved(emptyPlayDraft(uid), 0)
    // restoreSaved only reads uid and flow, which these pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, wantsEdit])

  // Keep the draft on this device as it changes.
  useEffect(() => {
    if (!uid || restoredKey !== `${uid}:${flow}` || finished.current) return
    const photos = storablePhotos(draft.photos)
    saveDraft(uid, flow, stepIndex, {
      draft: { ...draft, photos },
      photosMissing: photoReminder || photos.length < draft.photos.length,
    })
  }, [uid, flow, restoredKey, stepIndex, draft, photoReminder])

  function markSaved() {
    finished.current = true
    clearDraft(uid, flow)
  }

  // Everyone here already has an account, so leaving goes to the profile
  // (not history back, which can leave the app) and drops the saved draft.
  function exit() {
    finished.current = true
    clearDraft(uid, flow)
    navigate('/profile', { replace: true })
  }

  useEffect(() => {
    if (!wantsEdit || !uid) return
    let cancelled = false
    loadPlayDraft(uid, selectPlayPrompts(uid).map((p) => p.id))
      .catch(() => null)
      .then((saved) => {
        if (cancelled) return
        if (!saved) {
          // Nothing saved to edit: a normal setup, under the edit flow's key.
          restoreSaved(emptyPlayDraft(uid), 0)
          return setEdit('none')
        }
        restoreSaved(saved, STEPS.indexOf('photos'))
        setBioEditing(saved.bio.trim() !== '')
        setEdit('ready')
      })
    return () => {
      cancelled = true
    }
    // restoreSaved only reads uid and flow, which these pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsEdit, uid])

  // Identity for the bio prompt; on a first setup, height and body type are
  // pre-filled from the Spark profile (still editable on "About you").
  useEffect(() => {
    if (!uid) return
    getDoc(doc(db, 'users', uid))
      .then(async (snap) => {
        const data = snap.data()
        // attractedTo is a matching preference (owner-only, private/matching).
        setIdentity({ genderIdentity: data?.genderIdentity, attractedTo: (await loadMatching(uid, data)).attractedTo })
        setNames({
          displayName: typeof data?.displayName === 'string' ? data.displayName : '',
          playNameLockedUntil: wantsEdit ? nextNameChange(data?.playDisplayNameUpdatedAt) : null,
        })
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
      case 'playName':
        return draft.playDisplayName.trim().length > 0
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
    // A restored draft can be missing its photos (they aren't stored).
    if (draft.photos.length === 0) {
      return setSaveError("Add at least one photo first — photos aren't kept if the page reloads.")
    }
    setSaving(true)
    setSaveError(null)
    setSaveProgress(null)
    try {
      if (editing) {
        const notices = await savePlayOnboarding(uid, draft, { keepIntent: true, onProgress: setSaveProgress })
        markSaved()
        const flash = notices.length > 0 ? notices.join(' ') : '✦ Play profile updated.'
        navigate('/profile', { replace: true, state: { flash } })
        return
      }
      const notices = await savePlayOnboarding(uid, draft, { onProgress: setSaveProgress })
      markSaved()
      // Saved; a photo still under review is explained before moving on.
      if (notices.length > 0) {
        setPhotoNotices(notices)
        setSaving(false)
        return
      }
      continueToPlay()
    } catch (err) {
      console.error('Play onboarding save failed:', err)
      setSaveError(friendlyError(err, "Couldn't save your Play profile. Check your connection and try again."))
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
            onChange={(photos) => {
              setPhotoReminder(false)
              update({ photos })
            }}
          />
        )
      case 'playName':
        return (
          <PlayNameStep
            {...props}
            lockedUntil={editing ? names.playNameLockedUntil : null}
            placeholder={names.displayName || undefined}
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
        <div className="mb-3 flex justify-end">
          <ExitLink
            label="Exit"
            question={editing ? 'Exit without saving?' : 'Exit Play setup? Your answers so far will be cleared.'}
            onConfirm={exit}
            disabled={saving || photoNotices !== null}
          />
        </div>
        {photoReminder && step !== 'photos' && (
          <div className="mb-5 flex items-center gap-3 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <p className="flex-1">Welcome back — your answers were saved, but photos need adding again.</p>
            <button
              type="button"
              onClick={() => setStepIndex(STEPS.indexOf('photos'))}
              className="shrink-0 font-semibold text-white underline underline-offset-2"
            >
              Add photos
            </button>
          </div>
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
            onClick={() => (isFirst ? exit() : setStepIndex((i) => i - 1))}
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
              {saving ? (saveProgress ?? 'Saving…') : editing ? 'Save changes ✦' : "🔥 Let's Play"}
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
