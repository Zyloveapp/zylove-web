import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { useModeStore } from '../store/modeStore'
import PhotosStep from '../components/onboarding/PhotosStep'
import { MAX_PHOTOS, releasePhotoPreview } from '../components/onboarding/types'
import {
  PLAY_NON_NEGOTIABLE_LABELS,
  PLAY_PROMPT_BANK,
  PLAY_TAG_LABELS,
  SPICE_META,
  selectPlayPrompts,
  type PlayInterestTag,
  type PlayNonNegotiable,
  type SpiceLevel,
} from '../types/dualProfile'
import {
  generatePlayBio,
  savePlayOnboarding,
  tagsIn,
  type PlayDraft,
  type PlayTagCategory,
  loadPlayDraft,
} from '../services/playOnboarding'

const RED = '#E03131'
const BIO_MAX = 300
const ANSWER_MAX = 200

// The bio comes after the prompts (as on mobile) so generation has something
// to work from.
const STEPS = ['welcome', 'photos', 'spice', 'arrangement', 'scene', 'nonNegotiables', 'prompts', 'bio', 'review'] as const
type StepId = (typeof STEPS)[number]

const SCENE_SECTIONS: { category: PlayTagCategory; title: string }[] = [
  { category: 'acts', title: "What I'm into" },
  { category: 'dynamic', title: 'My dynamic' },
  { category: 'vibe', title: 'My vibe' },
  { category: 'place', title: 'Where I play' },
]

function tagsOfCategory(category: PlayTagCategory): PlayInterestTag[] {
  return (Object.keys(PLAY_TAG_LABELS) as PlayInterestTag[]).filter((t) => PLAY_TAG_LABELS[t].category === category)
}

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

function promptText(id: string): string {
  return PLAY_PROMPT_BANK.find((p) => p.id === id)?.text ?? id
}

// "↻ Different question": the whole Play prompt bank in a dark red sheet.
// ✓ marks prompts you've written an answer for.
function PlayPromptPicker({
  current,
  answers,
  onPick,
  onClose,
}: {
  current: string
  answers: Record<string, string>
  onPick: (id: string) => void
  onClose: () => void
}) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="play-prompt-picker-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[80dvh] w-full flex-col rounded-t-2xl border border-[#E03131]/30 bg-[#140707] text-white lg:max-w-md lg:rounded-2xl">
        <div className="flex items-center justify-between border-b border-[#E03131]/20 px-6 py-4">
          <h2 id="play-prompt-picker-title" className="font-semibold">
            Choose a question
          </h2>
          <button type="button" onClick={onClose} className="text-sm text-white/50 hover:text-white">
            Cancel
          </button>
        </div>
        <ul className="overflow-y-auto px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">
          {PLAY_PROMPT_BANK.map((p) => {
            const answered = (answers[p.id] ?? '').trim() !== ''
            const isCurrent = p.id === current
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPick(p.id)}
                  aria-current={isCurrent}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors hover:bg-[#E03131]/10 ${
                    isCurrent ? 'bg-[#E03131]/15 text-white' : 'text-white/85'
                  }`}
                >
                  <span>{p.text}</span>
                  {answered && (
                    <span className="shrink-0 font-semibold text-[#FF6B6B]" aria-label="Answered">
                      ✓
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

// ─── UI pieces ───────────────────────────────────────────────────────────────

function Pill({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-full border px-3.5 py-2 text-sm transition-colors ${
        selected
          ? 'border-[#E03131]/40 bg-[#E03131]/20 text-red-400'
          : 'border-white/10 bg-white/5 text-white/70 hover:border-white/25'
      }`}
    >
      {children}
    </button>
  )
}

function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-white">{title}</h1>
      {subtitle && <p className="mt-1 text-white/50">{subtitle}</p>}
    </div>
  )
}

const primaryButton =
  'w-full rounded-xl bg-[#E03131] py-3 font-semibold text-white transition-colors hover:bg-[#E03131]/90 disabled:opacity-40'

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
  const [draft, setDraft] = useState<PlayDraft>(() => {
    const promptIds = selectPlayPrompts(uid).map((p) => p.id)
    return { photos: [], bio: '', spiceLevel: null, tags: [], nonNegotiables: [], promptIds, answers: {} }
  })
  const [openSections, setOpenSections] = useState<PlayTagCategory[]>(['acts'])
  const [bioEditing, setBioEditing] = useState(false)
  const [bioBusy, setBioBusy] = useState(false)
  const [bioMessage, setBioMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // The prompt slot whose question is being replaced from the picker.
  const [pickerSlot, setPickerSlot] = useState<number | null>(null)
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

  useEffect(() => {
    if (!uid) return
    getDoc(doc(db, 'users', uid))
      .then((snap) => setIdentity({ genderIdentity: snap.data()?.genderIdentity, attractedTo: snap.data()?.attractedTo }))
      .catch(() => {})
  }, [uid])

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
  const answeredCount = draft.promptIds.filter((id) => (draft.answers[id] ?? '').trim()).length

  function canAdvance(id: StepId): boolean {
    switch (id) {
      case 'photos':
        return draft.photos.length >= 1 && draft.photos.length <= MAX_PHOTOS
      case 'spice':
        return draft.spiceLevel !== null
      case 'arrangement':
        return tagsIn(draft.tags, 'arrangement').length > 0
      case 'prompts':
        return answeredCount >= 1
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
    if ('bio' in result) update({ bio: result.bio.slice(0, BIO_MAX) })
    else
      setBioMessage(
        result.error === 'limit'
          ? "You've used this week's 3 bio generations — write it yourself for now."
          : "Couldn't generate a bio right now. Try again or write it yourself.",
      )
    setBioBusy(false)
  }

  // Puts the picked prompt in the slot being replaced. A prompt already shown
  // in another slot swaps places instead. Answers stay in the draft (only
  // shown prompts are saved), so picking an earlier prompt brings its answer back.
  function pickPrompt(slot: number, id: string) {
    setPickerSlot(null)
    const ids = [...draft.promptIds]
    const other = ids.indexOf(id)
    if (other === slot) return
    if (other !== -1) ids[other] = ids[slot]
    ids[slot] = id
    update({ promptIds: ids })
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
    switch (step) {
      case 'welcome':
        return (
          <div className="flex min-h-[60dvh] flex-col justify-center text-center">
            <h1 className="text-5xl font-bold text-white">🔴 Play</h1>
            <p className="mt-4 text-xl text-white/80">Same you. Different energy. Entirely yours.</p>
            <p className="mt-4 text-white/50">
              Your Spark profile stays completely separate. What happens in Play, stays in Play.
            </p>
          </div>
        )

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
        return (
          <>
            <Heading title="Your spice level" subtitle="Be honest. It helps everyone." />
            <div className="space-y-3">
              {(Object.keys(SPICE_META) as SpiceLevel[]).map((level) => {
                const meta = SPICE_META[level]
                const selected = draft.spiceLevel === level
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => update({ spiceLevel: level })}
                    aria-pressed={selected}
                    className={`flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition-colors ${
                      selected ? 'border-[#E03131]/60 bg-[#E03131]/15' : 'border-white/10 bg-white/5 hover:border-white/25'
                    }`}
                  >
                    <span className="text-3xl" aria-hidden>
                      {meta.emoji}
                    </span>
                    <span className="flex-1">
                      <span className={`block font-semibold ${selected ? 'text-red-400' : 'text-white'}`}>{meta.label}</span>
                      <span className="mt-0.5 block text-sm text-white/50">{meta.description}</span>
                    </span>
                    {selected && <span className="text-lg font-bold text-red-400">✓</span>}
                  </button>
                )
              })}
            </div>
          </>
        )

      case 'arrangement':
        return (
          <>
            <Heading title="What are you looking for?" subtitle="Pick at least one." />
            <div className="flex flex-wrap gap-2">
              {tagsOfCategory('arrangement').map((t) => (
                <Pill key={t} selected={draft.tags.includes(t)} onClick={() => update({ tags: toggle(draft.tags, t) })}>
                  {PLAY_TAG_LABELS[t].emoji} {PLAY_TAG_LABELS[t].label}
                </Pill>
              ))}
            </div>
          </>
        )

      case 'scene':
        return (
          <>
            <Heading title="What's your scene?" subtitle="All optional — open any section that fits." />
            <div className="space-y-3">
              {SCENE_SECTIONS.map(({ category, title }) => {
                const open = openSections.includes(category)
                const count = tagsIn(draft.tags, category).length
                return (
                  <section key={category} className="rounded-2xl border border-white/10 bg-white/[0.03]">
                    <button
                      type="button"
                      onClick={() => setOpenSections((s) => toggle(s, category))}
                      aria-expanded={open}
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                    >
                      <span className="text-sm font-semibold uppercase tracking-widest text-[#E03131]/80">{title}</span>
                      <span className="text-sm text-white/40">
                        {count > 0 && `${count} selected · `}
                        {open ? '−' : '+'}
                      </span>
                    </button>
                    {open && (
                      <div className="flex flex-wrap gap-2 px-4 pb-4">
                        {tagsOfCategory(category).map((t) => (
                          <Pill key={t} selected={draft.tags.includes(t)} onClick={() => update({ tags: toggle(draft.tags, t) })}>
                            {PLAY_TAG_LABELS[t].emoji} {PLAY_TAG_LABELS[t].label}
                          </Pill>
                        ))}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          </>
        )

      case 'nonNegotiables':
        return (
          <>
            <Heading
              title="My non-negotiables"
              subtitle="What you always need. Others see this — it filters who reaches out."
            />
            <div className="flex flex-wrap gap-2">
              {(Object.keys(PLAY_NON_NEGOTIABLE_LABELS) as PlayNonNegotiable[]).map((k) => (
                <Pill
                  key={k}
                  selected={draft.nonNegotiables.includes(k)}
                  onClick={() => update({ nonNegotiables: toggle(draft.nonNegotiables, k) })}
                >
                  {PLAY_NON_NEGOTIABLE_LABELS[k]}
                </Pill>
              ))}
            </div>
          </>
        )

      case 'prompts':
        return (
          <>
            <Heading title="In your own words" subtitle="Answer at least one." />
            <div className="space-y-4">
              {draft.promptIds.map((id, i) => {
                const prompt = PLAY_PROMPT_BANK.find((p) => p.id === id)
                const answer = draft.answers[id] ?? ''
                return (
                  <div key={id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-semibold text-white">{promptText(id)}</p>
                      <button
                        type="button"
                        onClick={() => setPickerSlot(i)}
                        className="shrink-0 text-sm text-[#E03131]/80 hover:text-red-400"
                      >
                        ↻ Different question
                      </button>
                    </div>
                    <textarea
                      value={answer}
                      onChange={(e) => update({ answers: { ...draft.answers, [id]: e.target.value.slice(0, ANSWER_MAX) } })}
                      maxLength={ANSWER_MAX}
                      rows={3}
                      placeholder={prompt?.placeholder ?? 'Your answer…'}
                      className="mt-3 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-white placeholder:text-white/30 focus:border-[#E03131]/50 focus:outline-none"
                    />
                    <p className="text-right text-xs text-white/30">
                      {answer.length}/{ANSWER_MAX}
                    </p>
                  </div>
                )
              })}
            </div>
            {pickerSlot !== null && (
              <PlayPromptPicker
                current={draft.promptIds[pickerSlot]}
                answers={draft.answers}
                onPick={(id) => pickPrompt(pickerSlot, id)}
                onClose={() => setPickerSlot(null)}
              />
            )}
          </>
        )

      case 'bio':
        return (
          <>
            <Heading title="Set the tone" subtitle="Tell people what to expect." />
            {bioEditing ? (
              <>
                <textarea
                  value={draft.bio}
                  onChange={(e) => update({ bio: e.target.value.slice(0, BIO_MAX) })}
                  maxLength={BIO_MAX}
                  rows={6}
                  disabled={bioBusy}
                  placeholder={bioBusy ? 'Writing your bio…' : 'Your Play bio…'}
                  className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:border-[#E03131]/50 focus:outline-none disabled:opacity-60"
                />
                <div className="mt-2 flex items-center justify-between text-sm">
                  <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={bioBusy}
                    className="font-semibold text-red-400 hover:text-red-300 disabled:opacity-50"
                  >
                    {bioBusy ? 'Generating…' : '↺ Generate my Play bio'}
                  </button>
                  <span className="text-white/30">
                    {draft.bio.length}/{BIO_MAX}
                  </span>
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <button type="button" onClick={handleGenerate} className={primaryButton}>
                  ↺ Generate my Play bio
                </button>
                <button
                  type="button"
                  onClick={() => setBioEditing(true)}
                  className="w-full py-2 text-sm text-white/50 hover:text-white"
                >
                  Write it myself
                </button>
              </div>
            )}
            {bioMessage && <p className="mt-3 text-sm text-red-400">{bioMessage}</p>}
          </>
        )

      case 'review': {
        const spice = draft.spiceLevel ? SPICE_META[draft.spiceLevel] : null
        const firstAnswer = draft.promptIds.find((id) => (draft.answers[id] ?? '').trim())
        return (
          <>
            <Heading title="You're set." />
            <div className="space-y-5">
              {draft.photos[0] && (
                <img
                  src={draft.photos[0].previewUrl}
                  alt="Your main Play photo"
                  className="aspect-[3/4] w-full rounded-2xl object-cover"
                />
              )}
              {spice && (
                <span className="inline-block rounded-full border border-[#E03131]/40 bg-[#E03131]/20 px-3 py-1 text-sm text-red-400">
                  {spice.emoji} {spice.label}
                </span>
              )}
              {draft.bio.trim() && <p className="whitespace-pre-line text-lg leading-relaxed text-white/80">{draft.bio}</p>}
              {tagsIn(draft.tags, 'arrangement').length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {tagsIn(draft.tags, 'arrangement').map((t) => (
                    <span key={t} className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/70">
                      {PLAY_TAG_LABELS[t].emoji} {PLAY_TAG_LABELS[t].label}
                    </span>
                  ))}
                </div>
              )}
              {firstAnswer && (
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-sm text-white/40">{promptText(firstAnswer)}</p>
                  <p className="mt-1 text-white">{draft.answers[firstAnswer]}</p>
                </div>
              )}
              {saveError && <p className="text-sm text-red-400">{saveError}</p>}
            </div>
          </>
        )
      }
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
        {isLast && photoNotices && (
          <div className="mt-6 space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <p className="font-semibold">Your Play profile is saved.</p>
            {photoNotices.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        )}
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
              {saving ? 'Saving…' : editing ? 'Save changes ✦' : 'Enter Play ✦'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStepIndex((i) => i + 1)}
              disabled={!canAdvance(step)}
              className={primaryButton}
            >
              {isFirst ? "Let's go →" : step === 'scene' || step === 'nonNegotiables' ? 'Next (optional) →' : 'Next →'}
            </button>
          )}
        </div>
      </nav>
    </div>
  )
}
